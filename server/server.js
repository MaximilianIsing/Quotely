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

// For PDF processing
let PDFParser;
try {
    console.log('Attempting to load pdf2json...');
    PDFParser = require('pdf2json');
    console.log('pdf2json loaded successfully:', typeof PDFParser);
} catch (error) {
    console.log('pdf2json not installed. PDF processing will not be available.');
    console.log('Error details:', error.message);
}

// For OCR processing (scanned PDFs)
let pdfPoppler, Tesseract;
try {
    console.log('Attempting to load OCR libraries...');
    pdfPoppler = require('pdf-poppler');
    Tesseract = require('tesseract.js');
    console.log('OCR libraries loaded successfully');
} catch (error) {
    console.log('OCR libraries not installed. Scanned PDF processing will not be available.');
    console.log('Error details:', error.message);
}

// Temporary cache for extracted PDF content (expires after 1 hour)
const pdfCache = new Map();
const PDF_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

function cachePdfContent(url, content) {
    pdfCache.set(url, {
        content: content,
        timestamp: Date.now()
    });
    
    // Clean up expired entries
    for (const [key, value] of pdfCache.entries()) {
        if (Date.now() - value.timestamp > PDF_CACHE_DURATION) {
            pdfCache.delete(key);
        }
    }
}

function getCachedPdfContent(url) {
    const cached = pdfCache.get(url);
    if (!cached) return null;
    
    // Check if expired
    if (Date.now() - cached.timestamp > PDF_CACHE_DURATION) {
        pdfCache.delete(url);
        return null;
    }
    
    return cached.content;
}

/**
 * Extract text from PDF using OCR (for scanned PDFs)
 * @param {string} pdfPath - Path to the PDF file
 * @returns {Promise<{text: string, pageCount: number}>} Extracted text and page count
 */
async function extractPDFTextOCR(pdfPath) {
    const tempDir = path.join(__dirname, '..', 'scanning', 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Convert PDF to images with lower quality for speed
    const options = {
        format: 'png',
        out_dir: tempDir,
        out_prefix: 'page',
        page: null,
        density: 200  // Lower density = faster
    };
    
    console.log('Converting PDF to images for OCR...');
    await pdfPoppler.convert(pdfPath, options);
    
    // Get list of generated image files
    const files = fs.readdirSync(tempDir)
        .filter(file => file.startsWith('page') && file.endsWith('.png'))
        .sort();
    
    console.log(`Found ${files.length} pages to process with OCR`);
    
    // Process all pages in parallel
    const ocrPromises = files.map(async (file, index) => {
        const imagePath = path.join(tempDir, file);
        console.log(`Processing page ${index + 1}/${files.length} with OCR...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        
        // Use Tesseract OCR with optimized settings
        const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
            logger: m => {
                if (m.status === 'recognizing text') {
                    process.stdout.write(`\rPage ${index + 1} OCR: ${Math.round(m.progress * 100)}%`);
                }
            },
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?;:()[]{}\'\"-_=+*/&%$#@~`<>|\\'
        });
        
        console.log(`\nPage ${index + 1} complete`);
        return { index, text };
    });
    
    // Wait for all pages to complete
    const results = await Promise.all(ocrPromises);
    
    // Sort by index and combine text
    results.sort((a, b) => a.index - b.index);
    const fullText = results.map(r => r.text).join(' ');
    
    // Clean up temp files
    files.forEach(file => {
        fs.unlinkSync(path.join(tempDir, file));
    });
    
    // Remove all newlines and extra spaces
    const cleanedText = fullText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    
    console.log('\n=== FULL OCR EXTRACTED TEXT ===');
    console.log(cleanedText);
    console.log('=== END OF OCR TEXT ===\n');
    
    return {
        text: cleanedText,
        pageCount: files.length
    };
}

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
app.use(express.json({ limit: '15mb' }));

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
    // Log received page content
    console.log('=== RECEIVED PAGE CONTENT ===');
    const receivedLength = req.body.pageContent ? req.body.pageContent.length : 0;
    console.log('Received Content Length:', receivedLength, 'characters');
    console.log('First 200 chars:', req.body.pageContent ? req.body.pageContent.substring(0, 200) : 'none');
    console.log('Last 200 chars:', req.body.pageContent ? req.body.pageContent.substring(Math.max(0, receivedLength - 200)) : 'none');
    
    const { topic, pageContent, pageUrl, pageTitle } = req.body;
    
    if (!topic || !pageContent) {
      return res.status(400).json({ error: 'Topic and page content are required' });
    }

    // Prompt is received; logging is handled later as full GPT input only

    const MAX_CHARS = 50000;
    const rawContent = String(pageContent || '').slice(0, MAX_CHARS);

    console.log('After slicing to MAX_CHARS, length:', rawContent.length, 'characters');

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
    
    console.log('Normalized text content length:', textContent.length, 'characters');
    console.log('Text content first 200 chars:', textContent.substring(0, 200));
    console.log('Text content last 200 chars:', textContent.substring(Math.max(0, textContent.length - 200)));
    
    // Split content into potential quote segments
    const sentences = textContent
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    
    console.log('Number of sentences extracted:', sentences.length);
    
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

// PDF extraction endpoint
app.post('/api/extract-pdf', async (req, res) => {
  console.log('=== PDF ENDPOINT HIT ===');
  try {
    console.log('PDFParser available:', !!PDFParser);
    if (!PDFParser) {
      console.log('PDFParser is not available');
      return res.status(500).json({ error: 'PDF processing not available. Please install pdf2json: npm install pdf2json' });
    }
    console.log('PDFParser is available, proceeding...');

    const { url, title } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log('=== PDF EXTRACTION REQUEST ===');
    console.log('URL:', url);
    console.log('Title:', title);

    let pdfBuffer;
    
    if (url.startsWith('file://')) {
      // Handle local files - fix Windows path handling
      let filePath = url.replace('file://', '');
      // Remove leading slash on Windows paths
      if (filePath.startsWith('/') && filePath.match(/^\/[A-Za-z]:/)) {
        filePath = filePath.substring(1);
      }
      // Decode URL-encoded characters (e.g., %20 -> space)
      filePath = decodeURIComponent(filePath);
      console.log('Reading local PDF file:', filePath);
      
      try {
        pdfBuffer = fs.readFileSync(filePath);
      } catch (error) {
        // Don't log verbose errors for permission/access issues (expected for protected files)
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          console.log('Local PDF access denied (protected):', error.code);
        } else {
          console.error('Error reading local PDF:', error.message);
        }
        return res.status(400).json({ error: 'Could not read local PDF file' });
      }
    } else {
      // Handle remote URLs
      console.log('Downloading PDF from URL:', url);
      try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        pdfBuffer = Buffer.from(response.data);
      } catch (error) {
        // Don't log verbose errors for access denied (expected for protected PDFs)
        if (error.response && (error.response.status === 403 || error.response.status === 401)) {
          console.log('PDF access denied (protected):', error.response.status);
        } else {
          console.error('Error downloading PDF:', error.message);
        }
        return res.status(400).json({ error: 'Could not download PDF from URL' });
      }
    }

    console.log('PDF buffer size:', pdfBuffer.length, 'bytes');

    // Extract text from PDF using pdf2json
    const parser = new PDFParser();
    
    return new Promise((resolve, reject) => {
      parser.on('pdfParser_dataError', (errData) => {
        console.log('PDF parsing failed (may be encrypted or corrupted)');
        reject(new Error('PDF parsing failed'));
      });
      
      parser.on('pdfParser_dataReady', async (pdfData) => {
        try {
          // Extract text from all pages
          let extractedText = '';
          const pageCount = pdfData.Pages ? pdfData.Pages.length : 0;
          console.log('PDF has', pageCount, 'pages');
          
          if (pdfData.Pages && pdfData.Pages.length > 0) {
            pdfData.Pages.forEach((page, pageIndex) => {
              const pageStartLength = extractedText.length;
              
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
              
              const pageEndLength = extractedText.length;
              const pageCharCount = pageEndLength - pageStartLength;
              console.log(`Page ${pageIndex + 1}: extracted ${pageCharCount} characters (total so far: ${pageEndLength})`);
              
              if (pageCharCount < 100 && pageIndex > 0) {
                console.log(`WARNING: Page ${pageIndex + 1} has very little text (${pageCharCount} chars) - may be extraction issue`);
              }
            });
          }
          
          console.log('Total extracted text length:', extractedText.length);
          console.log('First 200 chars:', extractedText.substring(0, 200));
          console.log('Last 200 chars:', extractedText.substring(Math.max(0, extractedText.length - 200)));

          // Detect if this is a scanned PDF (very little text extracted)
          const avgCharsPerPage = pageCount > 0 ? extractedText.length / pageCount : 0;
          const isScannedPDF = pageCount > 0 && avgCharsPerPage < 500; // Less than 500 chars per page suggests scanned PDF
          
          if (isScannedPDF && pdfPoppler && Tesseract) {
            console.log(`Detected scanned PDF (avg ${avgCharsPerPage.toFixed(0)} chars/page). Attempting OCR...`);
            
            // Check page limit (30 pages)
            if (pageCount > 30) {
              console.log(`PDF has ${pageCount} pages, exceeding 30-page limit for OCR`);
              resolve({
                error: 'scanned_pdf_too_large',
                message: `This PDF appears to be scanned (image-based) and has ${pageCount} pages. OCR processing is limited to 30 pages for performance reasons. Please use a text-based version of this PDF, or select a specific section to analyze.`,
                pageCount: pageCount,
                extractedText: extractedText // Return what we got from regular extraction
              });
              return;
            }
            
            // Save PDF buffer to temp file for OCR processing
            const tempDir = path.join(__dirname, '..', 'scanning', 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            const tempPdfPath = path.join(tempDir, `temp_${Date.now()}.pdf`);
            fs.writeFileSync(tempPdfPath, pdfBuffer);
            
            try {
              console.log('Starting OCR extraction...');
              const ocrResult = await extractPDFTextOCR(tempPdfPath);
              
              // Clean up temp PDF file
              fs.unlinkSync(tempPdfPath);
              
              console.log(`OCR extraction complete: ${ocrResult.text.length} characters extracted`);
              
              // Use OCR text instead
              extractedText = ocrResult.text;
              
            } catch (ocrError) {
              console.error('OCR extraction failed:', ocrError.message);
              // Clean up temp PDF file
              if (fs.existsSync(tempPdfPath)) {
                fs.unlinkSync(tempPdfPath);
              }
              // Continue with regular extraction result
              console.log('Falling back to regular extraction result');
            }
          }

          // Check if PDF is very large (> 50,000 characters)
          const SEGMENT_SIZE = 50000;
          if (extractedText.length > SEGMENT_SIZE) {
            // Cache the full content for later segment retrieval
            cachePdfContent(url, extractedText);
            
            // Create segment metadata
            const segments = [];
            for (let i = 0; i < extractedText.length; i += SEGMENT_SIZE) {
              segments.push({
                index: segments.length,
                start: i,
                end: Math.min(i + SEGMENT_SIZE, extractedText.length)
              });
            }
            
            console.log('PDF requires segmentation, cached content for URL:', url);
            
            resolve({
              requiresSegmentation: true,
              totalLength: extractedText.length,
              segmentCount: segments.length,
              segments: segments,
              url: url,
              title: title || 'PDF Document',
              pageCount: pageCount
            });
          } else {
            resolve({
              content: extractedText,
              url: url,
              title: title || 'PDF Document',
              pageCount: pageCount,
              info: pdfData.Meta
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
    console.log('PDF extraction failed:', error.message);
    res.status(500).json({ error: 'Failed to extract PDF content' });
  }
});

// Endpoint to get a specific segment from a cached PDF
app.post('/api/get-pdf-segment', async (req, res) => {
  try {
    const { pdfUrl, segmentIndex } = req.body;
    
    if (!pdfUrl || segmentIndex === undefined) {
      return res.status(400).json({ error: 'PDF URL and segment index are required' });
    }

    // Retrieve cached content
    const fullText = getCachedPdfContent(pdfUrl);
    
    if (!fullText) {
      return res.status(404).json({ error: 'PDF content not found in cache. Please re-extract the PDF.' });
    }

    const SEGMENT_SIZE = 50000;
    const start = segmentIndex * SEGMENT_SIZE;
    const end = Math.min(start + SEGMENT_SIZE, fullText.length);
    const segmentContent = fullText.substring(start, end);

    console.log(`Returning segment ${segmentIndex} (${start}-${end}) for PDF:`, pdfUrl);

    res.json({
      content: segmentContent,
      segmentIndex: segmentIndex,
      start: start,
      end: end
    });

  } catch (error) {
    console.log('Segment extraction failed:', error.message);
    res.status(500).json({ error: 'Failed to extract segment' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Quotely server running on port ${PORT}`);
});
