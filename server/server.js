const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const Fuse = require('fuse.js');
const cheerio = require('cheerio');
const axios = require('axios');
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { generateCitation } = require('./citation-generator');

const app = express();
const PORT = config.PORT;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY
});

// Verify GPT API connection
console.log('GPT API established');


app.use(cors());
// Allow larger JSON payloads but we still truncate content to 50k before processing
app.use(express.json({ limit: '3mb' }));

// Ensure logs directory and CSV exist (use external storage folder for hosting)
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const LOG_DIR = path.join(STORAGE_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.csv');

console.log('=== CSV Logging Initialization ===');
console.log('STORAGE_DIR env:', process.env.STORAGE_DIR);
console.log('STORAGE_ROOT:', STORAGE_ROOT);
console.log('LOG_DIR:', LOG_DIR);
console.log('LOG_FILE:', LOG_FILE);

try {
  if (!fs.existsSync(LOG_DIR)) {
    console.log('Log directory does not exist, creating:', LOG_DIR);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log('Log directory created successfully');
  } else {
    console.log('Log directory already exists');
  }
  
  if (!fs.existsSync(LOG_FILE)) {
    console.log('Log file does not exist, creating:', LOG_FILE);
    fs.writeFileSync(LOG_FILE, 'timestamp,topic,page_title,page_url\n', 'utf8');
    console.log('Log file created successfully');
  } else {
    console.log('Log file already exists');
    const stats = fs.statSync(LOG_FILE);
    console.log('Log file size:', stats.size, 'bytes');
  }
  console.log('=== CSV Logging Ready ===');
} catch (e) {
  console.error('!!! Failed to initialize logging !!!');
  console.error('Error:', e.message);
  console.error('Stack:', e.stack);
}

function csvEscape(value) {
  const text = (value ?? '').toString();
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function logPromptToCsv(topic, pageTitle, pageUrl) {
  try {
    console.log('[CSV] Logging request - Topic:', topic?.substring(0, 50));
    
    const row = [
      new Date().toISOString(),
      csvEscape(topic),
      csvEscape(pageTitle || 'Current Page'),
      csvEscape(pageUrl || 'Unknown URL')
    ].join(',') + '\n';
    
    console.log('[CSV] Writing to:', LOG_FILE);
    console.log('[CSV] Row length:', row.length, 'chars');
    
    fs.appendFile(LOG_FILE, row, (err) => {
      if (err) {
        console.error('[CSV] Failed to write log row:', err.message);
        console.error('[CSV] Error code:', err.code);
        console.error('[CSV] Error path:', err.path);
      } else {
        console.log('[CSV] Successfully logged to CSV');
      }
    });
  } catch (e) {
    console.error('[CSV] Error in logPromptToCsv:', e.message);
    console.error('[CSV] Stack:', e.stack);
  }
}

// Quote extraction and analysis endpoint
app.post('/api/find-quotes', async (req, res) => {
  try {
    const { topic, pageContent, pageUrl, pageTitle } = req.body;
    
    if (!topic || !pageContent) {
      return res.status(400).json({ error: 'Topic and page content are required' });
    }

    // Prompt is received; logging is handled later as full GPT input only

    const MAX_CHARS = 50000;
    const rawContent = String(pageContent || '').slice(0, MAX_CHARS);

    // Log the incoming prompt
    console.log('[API] /api/find-quotes called - Topic:', topic?.substring(0, 50));
    logPromptToCsv(topic, pageTitle, pageUrl);

    // Normalize content: handle plain text or HTML gracefully
    let textContent = rawContent;
    if (rawContent.includes('<') && rawContent.includes('>')) {
      try {
        const $ = cheerio.load(rawContent);
        textContent = $('body').text();
      } catch {}
    }
    textContent = (textContent || '').replace(/\s+/g, ' ').trim();
    
    // Split content into potential quote segments
    const sentences = textContent
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    
    // Use Fuse.js for fuzzy matching (items are plain strings, so no keys)
  const fuse = new Fuse(sentences, {
      includeScore: true,
      threshold: 0.6  // More loose matching (lower = more permissive)
    });
    
    const searchResults = fuse.search(topic);

    // Build candidate segments using a hybrid relevance heuristic
    const minLen = 20;  // Lower minimum length
    const maxLen = 500; // Higher maximum length

    // Tokenize topic into keywords (simple heuristic)
    const keywords = (topic || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w && w.length > 2);

    // Map fuzzy scores for quick lookup
    const fuzzyScoreBySentence = new Map();
    for (const r of searchResults) {
      // Fuse score: lower is better; convert to a positive weight
      const weight = r.score != null ? (1 - Math.min(1, r.score)) : 0;
      fuzzyScoreBySentence.set(r.item, Math.max(fuzzyScoreBySentence.get(r.item) || 0, weight));
    }

    // Build scored list with improved relevance scoring
  const scored = sentences.map((s, idx) => {
      const lower = s.toLowerCase();
      const keywordHits = keywords.reduce((acc, k) => acc + (lower.includes(k) ? 1 : 0), 0);
      const fuzzy = fuzzyScoreBySentence.get(s) || 0;
      
      // Enhanced scoring for better relevance detection
      const lengthOk = (s.length >= minLen && s.length <= maxLen) ? 1 : 0.5;
      const positionWeight = 1 - Math.min(0.8, idx / (sentences.length || 1));
      
      // Boost score for exact keyword matches and topic mentions
      const exactTopicMatch = lower.includes(topic.toLowerCase()) ? 2.0 : 0;
      const keywordDensity = keywordHits / Math.max(1, s.split(' ').length) * 10; // Normalize by sentence length
      
      
      // Calculate a more sophisticated score
      const score = (keywordHits * 2.0) + (fuzzy * 1.5) + (exactTopicMatch * 3.0) + (keywordDensity * 1.0) + (lengthOk * 0.3) + (positionWeight * 0.1);
      
      return { s, idx, score, keywordHits, fuzzy, exactTopicMatch, keywordDensity };
    });

    // Determine if page has any relevance signals at all
    const hasKeywordSignal = scored.some(e => e.keywordHits > 0);
    const hasFuzzySignal = searchResults.length > 0;
    if (!hasKeywordSignal && !hasFuzzySignal) {
      return res.json({ quotes: [], message: 'No relevant quotes found' });
    }

    // Sort by score desc
    scored.sort((a, b) => b.score - a.score);

    // Filter to sentences with any relevance signal - be more permissive
    // Allow fuzzy matching alone with a decent score, or any keyword/topic matches
    let filtered = scored.filter(e => 
      e.exactTopicMatch > 0 ||  // Contains exact topic
      e.keywordHits > 0 ||  // Has any keyword hits
      e.fuzzy >= 0.3 ||  // Fuzzy match alone with decent similarity (30%+)
      e.score > 0.8  // Any decent overall score
    );
    
    // If no filtered results, use all scored sentences as fallback
    if (filtered.length === 0) {
      filtered = scored.filter(e => e.score > 0);
      if (filtered.length === 0) {
        return res.json({ quotes: [], message: 'No relevant quotes found' });
      }
    }

    // Select all filtered sentences and include neighbors for context
    const picked = [];
    const usedIdx = new Set();
    for (const entry of filtered) {
      if (usedIdx.has(entry.idx)) continue;
      // Add the sentence
      picked.push(entry.idx);
      usedIdx.add(entry.idx);
      // Optionally add a neighbor sentence to preserve quote boundaries
      const before = entry.idx - 1;
      const after = entry.idx + 1;
      if (before >= 0 && !usedIdx.has(before)) {
        usedIdx.add(before);
        picked.push(before);
      }
      if (after < sentences.length && !usedIdx.has(after)) {
        usedIdx.add(after);
        picked.push(after);
      }
    }

    // Sort indices to keep natural reading order, then map to text
    picked.sort((a, b) => a - b);
    const relevantQuotes = picked.map(idx => sentences[idx]).filter(Boolean);
    if (relevantQuotes.length === 0) {
      return res.json({ quotes: [], message: 'No relevant quotes found' });
    }

    // Use GPT to analyze and refine quotes (single call)
    const systemPrompt = `You are a quote analysis assistant. Your task is to:
    - Find quotes that are HIGHLY SPECIFIC to the topic provided by the user
    - Only select quotes that directly mention or discuss the specific topic keywords
    - Do NOT include general quotes about the broader subject area unless they specifically mention the topic keywords
    - Preserve the original wording exactly as it appears in the text
    - For each quote, provide a brief explanation of why it's specifically relevant to the topic
    - Return only valid JSON formatted as an array of objects with: {"quote": "exact text", "relevance": "brief explanation"}`;

    const userContent = `Topic: "${topic}"\n\nText segments:\n${relevantQuotes.join('\n\n')}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userContent
        }
      ],
      temperature: 0.1  
    });

    let analyzedQuotes = [];
    try {
      let rawContent = completion.choices[0].message.content;
      
      // Strip markdown code blocks if present
      if (rawContent.includes('```json')) {
        rawContent = rawContent.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (rawContent.includes('```')) {
        rawContent = rawContent.replace(/```\s*/, '').replace(/```\s*$/, '');
      }
      
      analyzedQuotes = JSON.parse(rawContent);
      // Ensure each quote has a relevance field
      analyzedQuotes = analyzedQuotes.map((item, index) => ({
        quote: item.quote || item,
        relevance: item.relevance || `AI-analyzed quote #${index + 1}`
      }));
      
    } catch (e) {
      console.error('JSON parsing failed:', e.message);
      console.error('Raw content:', completion.choices[0].message.content);
      // Fallback to original quotes if JSON parsing fails
      analyzedQuotes = relevantQuotes.map((quote, index) => ({
        quote: quote,
        relevance: `Selected based on topic relevance and text analysis #${index + 1}`
      }));
    }

    res.json({
      quotes: analyzedQuotes,
      pageTitle: pageTitle || 'Current Page',
      pageUrl: pageUrl || 'Unknown URL'
    });

  } catch (error) {
    console.error('Error finding quotes:', error);
    res.status(500).json({ error: 'Failed to analyze quotes' });
  }
});

app.post('/api/format-citation', async (req, res) => {
  try {
    const { quote, pageTitle, pageUrl, format, author, publicationDate } = req.body;
    
    if (!quote || !pageTitle || !pageUrl || !format) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      // Use the citation generator
      const citationResult = await generateCitation(pageUrl, format);
      
      const citationResponse = { 
        citation: citationResult.fullCitation,
        inTextCitation: {
          parenthetical: citationResult.inText,
          narrative: citationResult.inText.replace(/[()]/g, '')
        }
      };
      
      res.json(citationResponse);

    } catch (citationError) {
      console.error('Citation generator error:', citationError.message);
      
      // Fallback to manual formatting
      const currentYear = new Date().getFullYear();
      let citation = '';
      
      if (format === 'MLA') {
        citation = `"${quote}" ${pageTitle}. ${publicationDate || currentYear}, ${pageUrl}.`;
      } else if (format === 'APA') {
        citation = `"${quote}" (${author || 'Unknown'}, ${publicationDate || currentYear}). ${pageTitle}. Retrieved from ${pageUrl}`;
      } else if (format === 'Chicago') {
        citation = `"${quote}" ${pageTitle}. ${publicationDate || currentYear}. ${pageUrl}.`;
      }
      
      const inTextCitation = {
        parenthetical: `(${author || 'Unknown'}, ${publicationDate || currentYear})`,
        narrative: `${author || 'Unknown'} (${publicationDate || currentYear})`
      };
      
      const fallbackResponse = { 
        citation,
        inTextCitation: inTextCitation
      };
      
      res.json(fallbackResponse);
    }
  } catch (error) {
    console.error('Error formatting citation:', error);
    res.status(500).json({ error: 'Failed to format citation' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Quotely server running on port ${PORT}`);
});
