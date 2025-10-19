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

// Debugging flag - read from debugtoggle.txt (must be 'true' or 'false')
let Debugging = false; // default value
try {
  const debugTogglePath = path.join(__dirname, '..', 'debugtoggle.txt');
  const debugValue = fs.readFileSync(debugTogglePath, 'utf8').trim().toLowerCase();
  Debugging = debugValue === 'true';
  if (Debugging) {
    console.log(`[DEBUG] Debugging mode is ENABLED`);
  } else {
    console.log(`[DEBUG] Debugging mode is DISABLED`);
  }
} catch (error) {
  console.warn('Could not read debugtoggle.txt, using default value (false):', error.message);
}

// For PDF processing
let PDFParser;
try {
    PDFParser = require('pdf2json');
} catch (error) {
    console.error('PDF processing not available:', error.message);
}

// For OCR processing (scanned PDFs) using Google Cloud Vision
let vision, visionClient;
try {
    vision = require('@google-cloud/vision');
    
    // Initialize Vision client with credentials
    if (config.GOOGLE_CREDENTIALS_PATH) {
        visionClient = new vision.ImageAnnotatorClient({
            keyFilename: config.GOOGLE_CREDENTIALS_PATH
        });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        visionClient = new vision.ImageAnnotatorClient();
    } else {
        console.error('⚠️  Google Cloud Vision credentials not found. OCR will not be available.');
    }
} catch (error) {
    console.error('Google Cloud Vision not available:', error.message);
}

// Temporary cache for extracted PDF content (expires after 5 minutes)
const pdfCache = new Map();
const PDF_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 15; // Maximum number of cached PDFs

function cachePdfContent(url, content, isOCR = false) {
    if (Debugging) console.log(`[DEBUG] Caching PDF content for: ${url} (OCR: ${isOCR})`);
    // Clean up expired entries first
    for (const [key, value] of pdfCache.entries()) {
        if (Date.now() - value.timestamp > PDF_CACHE_DURATION) {
            pdfCache.delete(key);
            if (Debugging) console.log(`[DEBUG] Removed expired cache entry: ${key}`);
        }
    }
    
    // If cache is at max size and this is a new entry, remove oldest
    if (pdfCache.size >= MAX_CACHE_SIZE && !pdfCache.has(url)) {
        let oldestKey = null;
        let oldestTime = Date.now();
        
        for (const [key, value] of pdfCache.entries()) {
            if (value.timestamp < oldestTime) {
                oldestTime = value.timestamp;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            pdfCache.delete(oldestKey);
        }
    }
    
    pdfCache.set(url, {
        content: content,
        isOCR: isOCR,
        timestamp: Date.now()
    });
}

function getCachedPdfContent(url) {
    const cached = pdfCache.get(url);
    if (!cached) {
        if (Debugging) console.log(`[DEBUG] Cache miss for: ${url}`);
        return null;
    }
    
    // Check if expired
    if (Date.now() - cached.timestamp > PDF_CACHE_DURATION) {
        pdfCache.delete(url);
        if (Debugging) console.log(`[DEBUG] Cache expired for: ${url}`);
        return null;
    }
    
    if (Debugging) console.log(`[DEBUG] Cache hit for: ${url}`);
    // Update timestamp for LRU (Least Recently Used)
    cached.timestamp = Date.now();
    pdfCache.set(url, cached);
    
    return cached; // Return full cached object with content and isOCR flag
}

/**
 * Extract text from PDF using Google Cloud Vision OCR (for scanned PDFs)
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {number} totalPages - Total number of pages in the PDF
 * @returns {Promise<{text: string, pageCount: number}>} Extracted text and page count
 */
async function extractPDFTextOCR(pdfBuffer, totalPages) {
    if (Debugging) console.log(`[DEBUG] Starting OCR extraction for ${totalPages} pages`);
    if (!visionClient) {
        throw new Error('Google Cloud Vision is not configured. Please set up credentials.');
    }
    
    const base64Pdf = pdfBuffer.toString('base64');
    
    // Google Cloud Vision has a 5-page limit per request
    // Break pages into chunks of 5 and process in parallel
    const PAGES_PER_REQUEST = 5;
    const chunks = [];
    
    for (let i = 1; i <= totalPages; i += PAGES_PER_REQUEST) {
        const endPage = Math.min(i + PAGES_PER_REQUEST - 1, totalPages);
        const pageRange = [];
        for (let p = i; p <= endPage; p++) {
            pageRange.push(p);
        }
        chunks.push(pageRange);
    }
    
    // Processing pages in chunks of 5
    if (Debugging) console.log(`[DEBUG] Processing ${chunks.length} chunks in parallel`);
    
    // Process all chunks in parallel
    const chunkPromises = chunks.map(async (pageRange, chunkIndex) => {
        if (Debugging) console.log(`[DEBUG] Processing chunk ${chunkIndex + 1}/${chunks.length} (pages ${pageRange[0]}-${pageRange[pageRange.length - 1]})`);

        const [response] = await visionClient.batchAnnotateFiles({
            requests: [{
                inputConfig: {
                    mimeType: 'application/pdf',
                    content: base64Pdf
                },
                features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
                pages: pageRange
            }]
        });
        
        const pdfResponse = response.responses[0];
        let chunkText = '';
        
        if (pdfResponse.responses) {
            pdfResponse.responses.forEach((pageResponse) => {
                if (pageResponse.fullTextAnnotation) {
                    chunkText += pageResponse.fullTextAnnotation.text + ' ';
                }
            });
        }
        
        return {
            chunkIndex,
            text: chunkText,
            pageRange
        };
    });
    
    // Wait for all chunks to complete
    const results = await Promise.all(chunkPromises);
    if (Debugging) console.log(`[DEBUG] All OCR chunks completed`);
    
    // Sort by chunk index and combine text
    results.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const fullText = results.map(r => r.text).join(' ');
    
    // Remove all newlines and extra spaces
    const cleanedText = fullText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    if (Debugging) console.log(`[DEBUG] OCR extracted ${cleanedText.length} characters`);
    
    return {
        text: cleanedText,
        pageCount: totalPages
    };
}

const app = express();
const PORT = config.PORT;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY
});


app.use(cors());
// Allow larger JSON payloads but we still truncate content to 50k before processing
app.use(express.json({ limit: '15mb' }));

// Set request timeout to 60 seconds to prevent hung requests from holding memory
app.use((req, res, next) => {
  req.setTimeout(60000); // 60 seconds
  res.setTimeout(60000);
  next();
});

// Ensure logs directory and CSV exist (use external storage folder for hosting)
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const LOG_DIR = path.join(STORAGE_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.csv');
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'timestamp,topic,page_title,page_url\n', 'utf8');
  }
} catch (e) {
  console.error('Failed to initialize logging:', e);
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
    const row = [
      new Date().toISOString(),
      csvEscape(topic),
      csvEscape(pageTitle || 'Current Page'),
      csvEscape(pageUrl || 'Unknown URL')
    ].join(',') + '\n';
    fs.appendFile(LOG_FILE, row, (err) => {
      if (err) console.error('Failed to write log row:', err);
    });
  } catch (e) {
    console.error('Error logging prompt:', e);
  }
}

// Quote extraction and analysis endpoint
app.post('/api/find-quotes', async (req, res) => {
  try {
    const { topic, pageContent, pageUrl, pageTitle, isOCR, fromPdf } = req.body;
    if (Debugging) console.log(`[DEBUG] /api/find-quotes - Topic: "${topic}", URL: ${pageUrl}, Content length: ${pageContent?.length || 0}, OCR: ${isOCR}, From PDF: ${fromPdf}`);

    if (!topic || !pageContent) {
      return res.status(400).json({ error: 'Topic and page content are required' });
    }

    // Prompt is received; logging is handled later as full GPT input only

    const MAX_CHARS = 50000;
    const rawContent = String(pageContent || '').slice(0, MAX_CHARS);
    if (Debugging) console.log(`[DEBUG] Processed content: ${rawContent.length} characters (truncated from ${pageContent?.length || 0})`);

    // Log the incoming prompt
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
    if (Debugging) console.log(`[DEBUG] Split content into ${sentences.length} sentences`);
    
    // Use Fuse.js for fuzzy matching (items are plain strings, so no keys)
  let fuse = new Fuse(sentences, {
      includeScore: true,
      threshold: 0.6  // More loose matching (lower = more permissive)
    });
    
    const searchResults = fuse.search(topic);
    fuse = null; // Allow garbage collection of Fuse.js index
    if (Debugging) console.log(`[DEBUG] Fuse.js found ${searchResults.length} fuzzy matches`);

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
    if (Debugging) console.log(`[DEBUG] Relevance signals - Keyword: ${hasKeywordSignal}, Fuzzy: ${hasFuzzySignal}`);
    if (!hasKeywordSignal && !hasFuzzySignal) {
      if (Debugging) console.log(`[DEBUG] No relevance signals found, returning empty result`);
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
    if (Debugging) console.log(`[DEBUG] Selected ${relevantQuotes.length} relevant quote segments`);
    if (relevantQuotes.length === 0) {
      return res.json({ quotes: [], message: 'No relevant quotes found' });
    }

    // Use GPT to analyze and refine quotes (single call)
    const ocrNote = isOCR ? '\n\nIMPORTANT: This text was extracted using OCR (Optical Character Recognition) and may contain spelling or grammar errors. Please correct any obvious spelling and grammar mistakes in the quotes while preserving the original meaning and intent.' : '';
    
    const systemPrompt = `You are a quote analysis assistant. Your task is to:
    - Find quotes that are HIGHLY SPECIFIC to the topic provided by the user
    - Only select quotes that DIRECTLY mention or discuss the EXACT topic keywords provided
    - EXCLUDE any quotes that do not explicitly mention the topic or are only tangentially related
    - Do NOT include general quotes about the broader subject area unless they specifically use the exact topic keywords
    - Do NOT include quotes that are merely contextually related without directly addressing the topic
    - If no quotes are highly relevant to the specific topic, return an empty array
    - Preserve the original wording exactly as it appears in the text${ocrNote}
    - For each quote, provide a brief explanation of why it's specifically relevant to the topic
    - Return only valid JSON formatted as an array of objects with: {"quote": "exact text", "relevance": "brief explanation"}`;

    const userContent = `Topic: "${topic}"\n\nText segments:\n${relevantQuotes.join('\n\n')}`;
    if (Debugging) console.log(`[DEBUG] Calling GPT-4.1-nano for quote analysis (${userContent.length} characters)`);

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
    if (Debugging) console.log(`[DEBUG] GPT response received`);

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
      if (Debugging) console.log(`[DEBUG] Successfully parsed ${analyzedQuotes.length} quotes from GPT`);
      
    } catch (e) {
      console.error('JSON parsing failed:', e.message);
      // Fallback to original quotes if JSON parsing fails
      analyzedQuotes = relevantQuotes.map((quote, index) => ({
        quote: quote,
        relevance: `Selected based on topic relevance and text analysis #${index + 1}`
      }));
    }

    if (Debugging) console.log(`[DEBUG] Returning ${analyzedQuotes.length} quotes to client`);
    res.json({
      quotes: analyzedQuotes,
      pageTitle: pageTitle || 'Current Page',
      pageUrl: pageUrl || 'Unknown URL',
      fromPdf: fromPdf || false // Flag indicating if quotes came from PDF processing
    });

  } catch (error) {
    console.error('Error finding quotes:', error);
    res.status(500).json({ error: 'Failed to analyze quotes' });
  }
});

app.post('/api/format-citation', async (req, res) => {
  try {
    const { quote, pageTitle, pageUrl, format, author, publicationDate } = req.body;
    if (Debugging) console.log(`[DEBUG] /api/format-citation - Format: ${format}, URL: ${pageUrl}`);
    
    if (!quote || !pageTitle || !pageUrl || !format) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      // Use the citation generator
      if (Debugging) console.log(`[DEBUG] Generating citation using citation-generator.js`);
      const citationResult = await generateCitation(pageUrl, format);
      if (Debugging) console.log(`[DEBUG] Citation generated successfully`);
      
      const citationResponse = { 
        citation: citationResult.fullCitation,
        inTextCitation: {
          parenthetical: citationResult.inText,
          narrative: citationResult.inText.replace(/[()]/g, '')
        }
      };
      
      res.json(citationResponse);

    } catch (citationError) {
      console.error('Citation error:', citationError.message);
      if (Debugging) console.log(`[DEBUG] Citation generation failed, using fallback formatting`);
      
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

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
  try {
    if (!PDFParser) {
      return res.status(500).json({ error: 'PDF processing not available. Please install pdf2json: npm install pdf2json' });
    }

    const { url, title, fileContent, isLocalFile } = req.body;
    if (Debugging) console.log(`[DEBUG] /api/extract-pdf - URL: ${url}, Local: ${isLocalFile}, Title: ${title}`);
    
    // Validate input
    if (!url && !fileContent) {
      return res.status(400).json({ error: 'URL or file content is required' });
    }

    let pdfBuffer;
    
    // Handle base64 file content (local files sent from extension)
    if (fileContent && isLocalFile) {
      try {
        pdfBuffer = Buffer.from(fileContent, 'base64');
        if (Debugging) console.log(`[DEBUG] Decoded local PDF file (${pdfBuffer.length} bytes)`);
      } catch (error) {
        return res.status(400).json({ error: 'Could not decode PDF file content' });
      }
    } 
    // Handle remote URLs
    else if (url && !url.startsWith('file://')) {
      try {
        if (Debugging) console.log(`[DEBUG] Downloading PDF from URL...`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        pdfBuffer = Buffer.from(response.data);
        if (Debugging) console.log(`[DEBUG] Downloaded PDF (${pdfBuffer.length} bytes)`);
      } catch (error) {
        return res.status(400).json({ error: 'Could not download PDF from URL' });
      }
    }
    // Legacy: file:// URLs (shouldn't happen with new client code)
    else if (url && url.startsWith('file://')) {
      return res.status(400).json({ error: 'Local file URLs are not supported. Please ensure your extension is up to date.' });
    }
    else {
      return res.status(400).json({ error: 'Invalid request format' });
    }

    // Extract text from PDF using pdf2json
    const parser = new PDFParser();
    
    return new Promise((resolve, reject) => {
      parser.on('pdfParser_dataError', (errData) => {
        reject(new Error('PDF parsing failed'));
      });
      
      parser.on('pdfParser_dataReady', async (pdfData) => {
        try {
          // Extract text from all pages
          let extractedText = '';
          const pageCount = pdfData.Pages ? pdfData.Pages.length : 0;
          if (Debugging) console.log(`[DEBUG] PDF parsed successfully - ${pageCount} pages`);
          
          if (pdfData.Pages && pdfData.Pages.length > 0) {
            pdfData.Pages.forEach((page, pageIndex) => {
              if (page.Texts) {
                page.Texts.forEach(text => {
                  if (text.R) {
                    text.R.forEach(r => {
                      if (r.T) {
                        extractedText += decodeURIComponent(r.T) + ' ';
                      }
                    });
                  }
                });
              }
            });
          }

          // Log all extracted PDF text
          if (Debugging) {
            console.log(`[DEBUG] ========== PDF TEXT EXTRACTED ==========`);
            console.log(extractedText);
            console.log(`[DEBUG] ========== END PDF TEXT ==========`);
          }

          // Detect if this is a scanned PDF (very little text extracted)
          const avgCharsPerPage = pageCount > 0 ? extractedText.length / pageCount : 0;
          const isScannedPDF = pageCount > 0 && avgCharsPerPage < 500; // Less than 500 chars per page suggests scanned PDF
          let ocrWasUsed = false; // Track if OCR was used
          if (Debugging) console.log(`[DEBUG] Extracted ${extractedText.length} characters (${avgCharsPerPage.toFixed(0)} avg per page), Scanned: ${isScannedPDF}`);
          
          if (isScannedPDF && visionClient) {
            // Check if we have cached OCR content for this PDF
            const cachedData = getCachedPdfContent(url);
            if (cachedData && cachedData.isOCR) {
              if (Debugging) console.log(`[DEBUG] Using cached OCR content`);
              extractedText = cachedData.content;
              ocrWasUsed = true;
            } else {
              if (Debugging) console.log(`[DEBUG] Starting OCR processing for scanned PDF`);
              
              // Check page limit (30 pages for performance)
              if (pageCount > 30) {
                resolve({
                  error: 'scanned_pdf_too_large',
                  message: `This PDF appears to be scanned (image-based) and has ${pageCount} pages. OCR processing is limited to 30 pages for performance reasons. Please use a text-based version of this PDF, or select a specific section to analyze.`,
                  pageCount: pageCount,
                  extractedText: extractedText
                });
                return;
              }
              
              try {
                const ocrResult = await extractPDFTextOCR(pdfBuffer, pageCount);
                
                // Use OCR text instead
                extractedText = ocrResult.text;
                // Mark that OCR was used
                ocrWasUsed = true;
                
                // Log OCR extracted text
                if (Debugging) {
                  console.log(`[DEBUG] ========== OCR TEXT EXTRACTED ==========`);
                  console.log(extractedText);
                  console.log(`[DEBUG] ========== END OCR TEXT ==========`);
                }
                
                // Cache the OCR result
                cachePdfContent(url, extractedText, true);
                
              } catch (ocrError) {
                console.error('OCR failed:', ocrError.message);
              }
            }
          }

          // Check if PDF is very large (> 50,000 characters)
          const SEGMENT_SIZE = 50000;
          // Use URL for remote files, or generate a stable cache key for local files
          // Use title + first 100 chars as a more stable identifier
          const cacheKey = url || `local_${title}_${extractedText.substring(0, 100).replace(/[^a-zA-Z0-9]/g, '')}`;
          
          if (extractedText.length > SEGMENT_SIZE) {
            if (Debugging) console.log(`[DEBUG] PDF is large (${extractedText.length} chars), creating ${Math.ceil(extractedText.length / SEGMENT_SIZE)} segments`);
            if (Debugging) console.log(`[DEBUG] Using cache key: ${cacheKey}`);
            // Cache the full content for later segment retrieval
            cachePdfContent(cacheKey, extractedText, ocrWasUsed);
            
            // Create segment metadata
            const segments = [];
            for (let i = 0; i < extractedText.length; i += SEGMENT_SIZE) {
              segments.push({
                index: segments.length,
                start: i,
                end: Math.min(i + SEGMENT_SIZE, extractedText.length)
              });
            }
            
            resolve({
              requiresSegmentation: true,
              totalLength: extractedText.length,
              segmentCount: segments.length,
              segments: segments,
              url: cacheKey,  // Use cache key instead of URL
              title: title || 'PDF Document',
              pageCount: pageCount,
              isOCR: ocrWasUsed
            });
          } else {
            resolve({
              content: extractedText,
              url: cacheKey,  // Use cache key instead of URL
              title: title || 'PDF Document',
              pageCount: pageCount,
              info: pdfData.Meta,
              isOCR: ocrWasUsed
            });
          }
        } catch (error) {
          reject(error);
        }
      });
      
      // Parse the PDF buffer
      parser.parseBuffer(pdfBuffer);
    }).then(result => {
      res.json(result);
    }).catch(error => {
      throw error;
    });

  } catch (error) {
    console.error('PDF extraction failed:', error.message);
    res.status(500).json({ error: 'Failed to extract PDF content' });
  }
});

// Endpoint to get a specific segment from a cached PDF
app.post('/api/get-pdf-segment', async (req, res) => {
  try {
    const { pdfUrl, segmentIndex } = req.body;
    if (Debugging) console.log(`[DEBUG] /api/get-pdf-segment - URL: ${pdfUrl}, Segment: ${segmentIndex}`);
    
    if (!pdfUrl || segmentIndex === undefined) {
      return res.status(400).json({ error: 'PDF URL and segment index are required' });
    }

    // Retrieve cached content
    if (Debugging) console.log(`[DEBUG] Looking for cached content with key: ${pdfUrl}`);
    const cached = getCachedPdfContent(pdfUrl);
    
    if (!cached) {
      if (Debugging) console.log(`[DEBUG] Cache miss for key: ${pdfUrl}`);
      return res.status(404).json({ error: 'PDF content not found in cache. Please re-extract the PDF.' });
    }
    
    if (Debugging) console.log(`[DEBUG] Cache hit! Found ${cached.content.length} characters`);

    const SEGMENT_SIZE = 50000;
    const start = segmentIndex * SEGMENT_SIZE;
    const end = Math.min(start + SEGMENT_SIZE, cached.content.length);
    const segmentContent = cached.content.substring(start, end);
    if (Debugging) console.log(`[DEBUG] Returning segment ${segmentIndex}: ${start}-${end} (${segmentContent.length} chars)`);

    res.json({
      content: segmentContent,
      segmentIndex: segmentIndex,
      start: start,
      end: end,
      isOCR: cached.isOCR || false
    });

  } catch (error) {
    console.error('Segment extraction failed:', error.message);
    res.status(500).json({ error: 'Failed to extract segment' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Quotely server running on port ${PORT}`);
    if (Debugging) console.log(`[DEBUG] Debugging mode is ENABLED`);
});
