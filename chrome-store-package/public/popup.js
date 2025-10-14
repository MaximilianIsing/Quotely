// Quotely Popup Script
class QuotelyPopup {
    constructor() {
        this.serverUrl = 'https://quotely-rmgh.onrender.com'; //https://quotely-rmgh.onrender.com
        this.lastPageTitle = null;
        this.lastPageUrl = null;
        this.storageKey = 'quotely_last_session';
        this.citationsKey = 'quotely_citations';
        this.quotesKey = 'quotely_quotes'; // Unified quote list with citation state
        this.segmentStateKey = 'quotely_segment_state'; // State for pending segment selection
        this.initializeElements();
        this.attachEventListeners();
        this.restoreLastSession();
        this.checkPendingSegmentSelection();
        
        // Also try to restore pins after a short delay in case session restoration didn't work

    }

    initializeElements() {
        this.topicInput = document.getElementById('topic-input');
        this.findQuotesBtn = document.getElementById('find-quotes-btn');
        this.resultsSection = document.getElementById('results-section');
        this.quotesContainer = document.getElementById('quotes-container');
        this.errorMessage = document.getElementById('error-message');
        this.citationFormat = document.getElementById('citation-format');
        this.btnText = this.findQuotesBtn.querySelector('.btn-text');
        this.searchIcon = this.findQuotesBtn.querySelector('.search-icon');
        this.loadingSpinner = this.findQuotesBtn.querySelector('.loading-spinner');
    }

    attachEventListeners() {
        this.findQuotesBtn.addEventListener('click', () => this.findQuotes());
        this.topicInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                this.findQuotes();
            }
        });
        this.topicInput.addEventListener('input', () => {
            this.saveCurrentInput();
        });
        this.citationFormat.addEventListener('change', () => this.updateAllCitations());
    }

    autoResizeTextarea() {
        // Reset height to auto to get the correct scrollHeight
        this.topicInput.style.height = 'auto';
        
        // Calculate the new height based on scrollHeight, always add 5px
        const newHeight = Math.min(this.topicInput.scrollHeight + 4, 120); // Max height of 120px
        
        // Set the new height
        this.topicInput.style.height = newHeight + 'px';
    }

    saveCurrentInput() {
        // Save the current input text to local storage
        const currentTopic = this.topicInput.value;
        if (currentTopic.trim()) {
            localStorage.setItem('quotely_current_topic', currentTopic);
        }
    }

    async findQuotes() {
        const topic = this.topicInput.value.trim();
        if (!topic) {
            this.showError('Please enter a topic to search for quotes.');
            return;
        }

        // Clear any pending segment selection state when starting a new search
        localStorage.removeItem(this.segmentStateKey);

        // Clear current page quotes when starting a new search (but keep pins)
        this.clearCurrentPageQuotes();

        // Collapse the container when starting a new search
        const container = document.querySelector('.container');
        container.classList.remove('expanded', 'medium-expanded', 'segment-expanded');

        this.setLoading(true);
        this.hideError();
        this.hideResults();

        try {
            // Get current tab information
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            // Check if this is a PDF page
            const isPDF = tab.url && (tab.url.includes('.pdf') || tab.url.startsWith('file://') && tab.url.endsWith('.pdf'));
            
            let pageData;
            
            if (isPDF) {
                // For PDFs, send the URL to server for pdf-parse processing
                console.log('PDF detected, sending to server for pdf-parse extraction...');
                try {
                    const pdfResponse = await fetch(`${this.serverUrl}/api/extract-pdf`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            url: tab.url,
                            title: tab.title
                        })
                    });
                    
                    if (pdfResponse.ok) {
                        pageData = await pdfResponse.json();
                        
                        console.log('=== PDF EXTRACTION ===');
                        
                        // Check if PDF requires segmentation
                        if (pageData.requiresSegmentation) {
                            console.log('PDF requires segmentation, total length:', pageData.totalLength, 'characters');
                            console.log('Number of segments:', pageData.segmentCount);
                            
                            // Temporarily stop loading to show segment selector
                            this.setLoading(false);
                            
                            // Show segment selection UI for PDF
                            const selectedSegmentIndex = await this.showPdfSegmentSelector(pageData, tab.url);
                            if (selectedSegmentIndex === null) {
                                // User cancelled (shouldn't happen as we removed cancel button, but just in case)
                                return;
                            }
                            
                            console.log('Requesting PDF segment', selectedSegmentIndex);
                            
                            // Request the specific segment from server
                            const segmentResponse = await fetch(`${this.serverUrl}/api/get-pdf-segment`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    pdfUrl: tab.url,
                                    segmentIndex: selectedSegmentIndex
                                })
                            });
                            
                            if (!segmentResponse.ok) {
                                throw new Error(`Segment retrieval failed: ${segmentResponse.status}`);
                            }
                            
                            const segmentData = await segmentResponse.json();
                            console.log('Received segment, length:', segmentData.content.length, 'characters');
                            
                            // Set pageData with the segment content
                            pageData = {
                                content: segmentData.content,
                                title: pageData.title,
                                url: pageData.url
                            };
                            
                            // Resume loading for quote finding
                            this.setLoading(true);
                        } else {
                            console.log('Extracted PDF content length:', (pageData.content || '').length, 'characters');
                        }
                    } else {
                        throw new Error(`PDF extraction failed: ${pdfResponse.status}`);
                    }
                } catch (error) {
                    console.error('PDF extraction error:', error);
                    
                    // Check if it's a scanned PDF error response
                    if (pageData.error === 'scanned_pdf_too_large' && pageData.message) {
                        this.showError(pageData.message);
                    } else {
                        this.showError('This PDF page is protected. Download this pdf locally then try again.');
                    }
                    return;
                }
                
                // Check if PDF exceeded 30-page limit (no content extracted)
                if (pageData && pageData.error === 'scanned_pdf_too_large') {
                    this.setLoading(false);
                    this.showError('This PDF requires scanning but exceeds the 30-page limit for OCR processing.');
                    return;
                }
            } else {
                // For HTML pages, use the existing extraction
                const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Beautiful Soup-like content extraction
                    function extractMainContent() {
                        // Get the full HTML
                        const html = document.documentElement.outerHTML;
                        
                        // Create a new DOMParser to parse the HTML
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        
                        // Remove unwanted elements (like Beautiful Soup's decompose())
                        const unwantedSelectors = [
                            'script', 'style', 'noscript', 'iframe', 'embed', 'object',
                            'nav', 'header', 'footer', 'aside', 'menu', 'sidebar',
                            '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
                            '.navigation', '.breadcrumb', '.pagination', '.ads', '.advertisement',
                            '.social', '.share', '.comments', '.related', '.recommended',
                            '.cookie-banner', '.popup', '.modal', '.overlay'
                        ];
                        
                        unwantedSelectors.forEach(selector => {
                            const elements = doc.querySelectorAll(selector);
                            elements.forEach(el => el.remove());
                        });
                        
                        // Find the main content using multiple strategies
                        const contentSelectors = [
                            'main', 'article', '[role="main"]',
                            '.content', '#content', '.main-content', '.article-content',
                            '.post-content', '.entry-content', '.document-content',
                            '.page-content', '.text-content', '.blog-content', '.post-body',
                            '.single-post', '.post', '.entry', '.story'
                        ];
                        
                        let mainContent = null;
                        
                        // Strategy 1: Find by semantic selectors
                        for (const selector of contentSelectors) {
                            const element = doc.querySelector(selector);
                            if (element && element.textContent.trim().length > 500) {
                                mainContent = element;
                                break;
                            }
                        }
                        
                        // Strategy 2: Find by content density (like Beautiful Soup's content scoring)
                        if (!mainContent) {
                            const body = doc.body;
                            if (body) {
                                const allDivs = body.querySelectorAll('div, section, p');
                                let bestCandidate = null;
                                let maxScore = 0;
                                
                                allDivs.forEach(el => {
                                    const text = el.textContent.trim();
                                    const textLength = text.length;
                                
                                    // Skip if too short or too long
                                    if (textLength < 200 || textLength > 100000) return;
                                    
                                    // Calculate content score (like Beautiful Soup)
                                    const links = el.querySelectorAll('a').length;
                                    const paragraphs = el.querySelectorAll('p').length;
                                    const images = el.querySelectorAll('img').length;
                                    
                                    // Higher score for more paragraphs and fewer links/images
                                    const score = paragraphs * 3 - links - images * 2 + (textLength / 100);
                                    
                                    if (score > maxScore) {
                                        maxScore = score;
                                        bestCandidate = el;
                                    }
                                });
                                
                                if (bestCandidate) {
                                    mainContent = bestCandidate;
                                }
                            }
                        }
                        
                        // Strategy 3: Fallback to body
                        if (!mainContent) {
                            mainContent = doc.body || doc.documentElement;
                        }
                        
                        // Extract clean text
                        let content = mainContent ? mainContent.textContent : '';
                        
                        // Clean up the content
                        content = content
                            .replace(/\s+/g, ' ') // Normalize whitespace
                            .replace(/^\s+|\s+$/g, '') // Trim
                            .replace(/[^\w\s.,!?;:'"()-]/g, '') // Remove special chars but keep punctuation
                            .trim();
                        
                        return content;
                    }
                    
                    const content = extractMainContent();
                    
                    return {
                        content: content,
                        url: window.location.href,
                        title: document.title
                    };
                }
            }).catch(() => []);

                if (!results || results.length === 0 || !results[0] || !results[0].result || !results[0].result.content) {
                    this.showError('Cannot access this page content. Try another tab.');
                    return;
                }

                pageData = results[0].result;
                console.log('=== HTML PAGE EXTRACTION ===');
                console.log('Extracted HTML content length:', (pageData.content || '').length, 'characters');
            }
            
            this.lastPageTitle = pageData.title || 'Current Page';
            this.lastPageUrl = pageData.url || 'Unknown URL';
            
            // Check if content is very large (> 50,000 characters) - for both PDF and HTML
            if (pageData.content && pageData.content.length > 50000) {
                console.log('Content is very large, showing segment selector...');
                
                // Temporarily stop loading to show segment selector
                this.setLoading(false);
                
                // Show segment selection UI
                const selectedSegment = await this.showSegmentSelector(pageData.content);
                if (selectedSegment === null) {
                    // User cancelled
                    console.log('User cancelled segment selection');
                    return;
                }
                
                console.log('Selected segment length:', selectedSegment.length, 'characters');
                
                // Replace content with selected segment
                pageData.content = selectedSegment;
                
                // Resume loading for quote finding
                this.setLoading(true);
            }
            
            // Log content length before sending
            console.log('=== FIND QUOTES: Content Length Check ===');
            console.log('Content length to send:', (pageData.content || '').length, 'characters');
            
            // Enforce 50k character limit client-side (safety check)
            const limitedContent = (pageData.content || '').slice(0, 50000);
            
            console.log('Final content length (sending to server):', limitedContent.length, 'characters');

            // Send to server for analysis
            const response = await fetch(`${this.serverUrl}/api/find-quotes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    topic: topic,
                    pageContent: limitedContent,
                    pageUrl: this.lastPageUrl,
                    pageTitle: this.lastPageTitle
                })
            });

            if (!response.ok) {
                if (response.status === 413) {
                    this.showError('The page is too large to analyze. Try a simpler page or select text and paste it instead.');
                    return;
                }
                throw new Error(`Server error: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.quotes && data.quotes.length > 0) {
                this.lastPageTitle = data.pageTitle || this.lastPageTitle;
                this.lastPageUrl = data.pageUrl || this.lastPageUrl;
                this.displayQuotes(data.quotes, this.lastPageTitle, this.lastPageUrl);
            } else {
                this.showError('No relevant quotes found. Try a different topic or check if the page has relevant content.');
            }

        } catch (error) {
            console.error('Error finding quotes:', error);
            this.showError('Failed to find quotes. The server might be offline. Please try again later.');
        } finally {
            this.setLoading(false);
        }
    }

    async showPdfSegmentSelector(pdfData, pdfUrl = null) {
        // Save PDF segment selection state
        const segmentState = {
            isPdf: true,
            pdfData: pdfData,
            pdfUrl: pdfUrl,
            topic: this.topicInput.value,
            pageTitle: this.lastPageTitle || pdfData.title,
            pageUrl: this.lastPageUrl || pdfUrl,
            timestamp: Date.now()
        };
        localStorage.setItem(this.segmentStateKey, JSON.stringify(segmentState));

        return new Promise((resolve) => {
            console.log('Showing PDF segment selector with', pdfData.segmentCount, 'segments');

            // Hide the current results/error sections
            this.hideResults();
            this.hideError();

            // Hide the results header (Found Quotes and Citation Format)
            const resultsHeader = document.querySelector('.results-header');
            if (resultsHeader) {
                resultsHeader.style.display = 'none';
            }

            // Create segment selector UI
            const selectorHTML = `
                <div class="segment-container">
                    <div class="segment-selector">
                        <p style="margin-bottom: 0px;">Woah, that's a lot of text! (${Math.round(pdfData.totalLength / 1000)}k characters)</p>
                        <p style="margin-top: 0; margin-bottom: 8px;">Select a segment to scan:</p>
                        <div class="segments-list">
                            ${this.createSegmentRows(pdfData.segments)}
                        </div>
                    </div>
                </div>
            `;

            this.quotesContainer.innerHTML = selectorHTML;
            this.resultsSection.style.display = 'block';

            // Expand container to show segments
            const container = document.querySelector('.container');
            container.classList.add('segment-expanded');

            // Add event listeners with slight delay to ensure DOM is ready
            setTimeout(() => {
                const segmentButtons = this.quotesContainer.querySelectorAll('.segment-option');

                console.log('Found', segmentButtons.length, 'PDF segment buttons');

                segmentButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const index = parseInt(btn.dataset.index);
                        console.log('Selected PDF segment', index + 1);
                        
                        // Clear segment selection state
                        localStorage.removeItem(this.segmentStateKey);
                        
                        // Collapse container and hide segment selector
                        const container = document.querySelector('.container');
                        container.classList.remove('expanded', 'medium-expanded', 'segment-expanded');
                        this.hideResults();
                        
                        // Resolve with the selected segment index
                        resolve(index);
                    });
                });
            }, 100);
        });
    }

    createSegmentRows(segments) {
        const rows = [];
        for (let i = 0; i < segments.length; i += 5) {
            const rowSegments = segments.slice(i, i + 5);
            const rowHTML = `
                <div class="segment-row">
                    ${rowSegments.map(seg => `
                        <button class="segment-option" data-index="${seg.index}" title="Characters ${seg.start.toLocaleString()} - ${seg.end.toLocaleString()}">
                            ${seg.index + 1}
                        </button>
                    `).join('')}
                </div>
            `;
            rows.push(rowHTML);
        }
        return rows.join('');
    }

    async showSegmentSelector(fullText, topic = null) {
        // Save segment selection state
        const segmentState = {
            fullText: fullText,
            topic: topic || this.topicInput.value,
            pageTitle: this.lastPageTitle,
            pageUrl: this.lastPageUrl,
            timestamp: Date.now()
        };
        localStorage.setItem(this.segmentStateKey, JSON.stringify(segmentState));

        return new Promise((resolve) => {
            // Create segments
            const SEGMENT_SIZE = 50000;
            const segments = [];
            for (let i = 0; i < fullText.length; i += SEGMENT_SIZE) {
                const segmentText = fullText.substring(i, Math.min(i + SEGMENT_SIZE, fullText.length));
                // Escape HTML characters in preview
                const preview = this.escapeHtml(segmentText.substring(0, 150).trim()) + '...';
                segments.push({
                    index: segments.length,
                    start: i,
                    end: Math.min(i + SEGMENT_SIZE, fullText.length),
                    preview: preview
                });
            }

            console.log('Showing segment selector with', segments.length, 'segments');

            // Hide the current results/error sections
            this.hideResults();
            this.hideError();

            // Hide the results header (Found Quotes and Citation Format)
            const resultsHeader = document.querySelector('.results-header');
            if (resultsHeader) {
                resultsHeader.style.display = 'none';
            }

            // Create segment selector UI
            const selectorHTML = `
                <div class="segment-container">
                    <div class="segment-selector">
                        <p style="margin-bottom: 0px;">Woah, that's a lot of text! (${Math.round(fullText.length / 1000)}k characters)</p>
                        <p style="margin-top: 0; margin-bottom: 8px;">Select a segment to scan:</p>
                        <div class="segments-list">
                            ${this.createSegmentRows(segments)}
                        </div>
                    </div>
                </div>
            `;

            this.quotesContainer.innerHTML = selectorHTML;
            this.resultsSection.style.display = 'block';

            // Expand container to show segments
            const container = document.querySelector('.container');
            container.classList.add('segment-expanded');

            // Add event listeners with slight delay to ensure DOM is ready
            setTimeout(() => {
                const segmentButtons = this.quotesContainer.querySelectorAll('.segment-option');

                console.log('Found', segmentButtons.length, 'segment buttons');

                segmentButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const index = parseInt(btn.dataset.index);
                        const start = index * SEGMENT_SIZE;
                        const end = Math.min(start + SEGMENT_SIZE, fullText.length);
                        const selectedSegment = fullText.substring(start, end);
                        console.log('Selected segment', index + 1);
                        
                        // Clear segment selection state
                        localStorage.removeItem(this.segmentStateKey);
                        
                        // Collapse container and hide segment selector
                        const container = document.querySelector('.container');
                        container.classList.remove('expanded', 'medium-expanded', 'segment-expanded');
                        this.hideResults();
                        
                        // Resolve with the selected segment
                        resolve(selectedSegment);
                    });
                });
            }, 100);
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // extractPageContent removed; using inline function via chrome.scripting.executeScript

    displayQuotes(quotes, pageTitle, pageUrl) {
        this.quotesContainer.innerHTML = '';
        
        // Show the results header (Found Quotes and Citation Format)
        const resultsHeader = document.querySelector('.results-header');
        if (resultsHeader) {
            resultsHeader.style.display = '';
        }
        
        // First, append any pinned quotes from other sites
        this.appendPinnedQuotesFromOtherSites();
        
        // Get pinned quotes to check for duplicates
        const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
        const pinnedQuotes = pinned.map(pin => pin.quote);
        
        // Filter out quotes that are already pinned
        const newQuotes = quotes.filter(quoteData => {
            const quoteText = quoteData.quote || quoteData;
            return !pinnedQuotes.includes(quoteText);
        });
        
        
        // Then append the new quotes (excluding duplicates)
        newQuotes.forEach((quoteData, index) => {
            const quoteElement = this.createQuoteElement(quoteData, index, pageTitle, pageUrl);
            this.quotesContainer.appendChild(quoteElement);
        });

        this.showResults();
        // Save to local storage
        this.saveSession(quotes, pageTitle, pageUrl);
        
        // Restore citation states for all quotes
        this.restoreAllCitationStates();
        
        // Remove any previous expansion classes and add full expansion
        const container = document.querySelector('.container');
        container.classList.remove('medium-expanded');
        container.classList.add('expanded');
    }

    createQuoteElement(quoteData, index, pageTitle, pageUrl) {
        const quoteDiv = document.createElement('div');
        quoteDiv.className = 'quote-item';
        
        const quoteText = quoteData.quote || quoteData;
        const relevance = quoteData.relevance || 'Relevant to topic';
        
        quoteDiv.innerHTML = `
            <div class="quote-pin" data-index="${index}">
                <img src="../media/Pin.png" alt="Pin" style="width: 16px; height: 19px;">
            </div>
            <div class="quote-text">"${quoteText}"</div>
            <div class="quote-actions">
                <button class="action-btn copy-btn" data-quote="${quoteText.replace(/"/g, '&quot;')}">
                    Copy Quote
                </button>
                <button class="action-btn generate-citation-btn" data-index="${index}" data-title="${pageTitle.replace(/"/g, '&quot;')}" data-url="${pageUrl.replace(/"/g, '&quot;')}">
                    Generate Citation
                </button>
                <div class="quote-help" data-help="${relevance.replace(/"/g, '&quot;')}">
                    <img src="../media/Question Mark.png" alt="?" style="width: 16px; height: 16px;">
                </div>
            </div>
            <div class="citation-display" id="citation-${index}" style="display: none;"></div>
        `;
        
        // Add event listeners to the buttons
        const copyBtn = quoteDiv.querySelector('.copy-btn');
        const citationBtn = quoteDiv.querySelector('.generate-citation-btn');
        const pinBtn = quoteDiv.querySelector('.quote-pin');
        
        copyBtn.addEventListener('click', () => {
            const quote = copyBtn.getAttribute('data-quote');
            this.copyQuote(quote);
        });
        
        pinBtn.addEventListener('click', () => {
            const index = parseInt(pinBtn.getAttribute('data-index'));
            this.togglePin(index, pinBtn);
        });
        
        citationBtn.addEventListener('click', () => {
            const index = parseInt(citationBtn.getAttribute('data-index'));
            const title = citationBtn.getAttribute('data-title');
            const url = citationBtn.getAttribute('data-url');
            
            // Check if citation already exists
            const citationDisplay = document.getElementById(`citation-${index}`);
            if (citationDisplay && citationDisplay.innerHTML.trim() !== '') {
                // Citation exists, toggle it
                this.toggleCitation(index);
            } else {
                // No citation exists, generate new one
                this.generateCitation(index, title, url);
            }
        });
        
        return quoteDiv;
    }

    async generateCitation(index, pageTitle, pageUrl) {
        let quoteElement;
        let quoteText;
        
        // Handle both regular quotes (numeric index) and pinned quotes (string ID)
        if (typeof index === 'string' && index.startsWith('pinned-')) {
            // For pinned quotes, find by data-pinned-id
            quoteElement = document.querySelector(`[data-pinned-id="${index}"]`)?.closest('.quote-item');
            if (!quoteElement) {
                console.error('Pinned quote element not found for ID:', index);
                return;
            }
            quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
        } else {
            // For regular quotes, find by data-index attribute
            quoteElement = document.querySelector(`#quotes-container .quote-item .quote-pin[data-index="${index}"]`)?.closest('.quote-item');
            if (!quoteElement) {
                console.error('Quote element not found for index:', index);
                return;
            }
            quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
        }
        
        const citationDisplay = document.getElementById(`citation-${index}`);
        const format = this.citationFormat.value;
        const citationBtn = quoteElement.querySelector('.generate-citation-btn');

        // Show loading state in the button
        const originalText = citationBtn.textContent;
        citationBtn.innerHTML = `
            <div class="loading-spinner"></div>
            Generating...
        `;
        citationBtn.disabled = true;

        try {
            const response = await fetch(`${this.serverUrl}/api/format-citation`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    quote: quoteText,
                    pageTitle: pageTitle,
                    pageUrl: pageUrl,
                    format: format
                })
            });

            if (response.ok) {
                const data = await response.json();
                
                // Create citation items without outer box
                citationDisplay.innerHTML = `
                    <div class="citation-item">
                        <div class="citation-text">${data.citation}</div>
                        <button class="citation-copy-btn" data-citation="${data.citation.replace(/"/g, '&quot;')}">
                            Copy
                        </button>
                    </div>
                    ${data.inTextCitation ? `
                        <div class="citation-divider"></div>
                        <div class="citation-item">
                            <div class="citation-text">${data.inTextCitation.parenthetical || data.inTextCitation.narrative}</div>
                            <button class="citation-copy-btn" data-citation="${(data.inTextCitation.parenthetical || data.inTextCitation.narrative).replace(/"/g, '&quot;')}">
                                Copy
                            </button>
                        </div>
                    ` : ''}
                `;
                citationDisplay.style.display = 'block';
                
                // Add event listeners to copy buttons
                const copyBtns = citationDisplay.querySelectorAll('.citation-copy-btn');
                copyBtns.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const citation = btn.getAttribute('data-citation');
                        this.copyCitation(citation);
                    });
                });
                
                // Update quote citation state (generated and visible)
                this.updateQuoteCitationState(quoteText, true, true, data);
                
                // Change button to "Hide Citation"
                citationBtn.innerHTML = 'Hide Citation';
                citationBtn.disabled = false;
            } else {
                throw new Error(`Server error: ${response.status}`);
            }
        } catch (error) {
            console.error('Error generating citation:', error);
            citationDisplay.innerHTML = `
                <div style="color: #dc2626; text-align: center; padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;">
                    Error generating citation. Please try again.
                </div>
            `;
            citationDisplay.style.display = 'block';
            
            // Reset button
            citationBtn.innerHTML = originalText;
            citationBtn.disabled = false;
        }
    }

    updateAllCitations() {
        // First try to restore existing citations for the new format
        this.restoreCitations();
        
        // Then re-generate any that don't exist for the new format
        const citations = document.querySelectorAll('.citation-display');
        citations.forEach(citation => {
            if (citation.style.display !== 'none') {
                // Re-generate citation with new format
                const quoteItem = citation.closest('.quote-item');
                const quoteText = quoteItem.querySelector('.quote-text').textContent.replace(/"/g, '');
                const pageTitle = this.lastPageTitle || 'Current Page';
                const pageUrl = this.lastPageUrl || 'Current URL';
                
                this.generateCitation(Array.from(quoteItem.parentNode.children).indexOf(quoteItem), pageTitle, pageUrl);
            }
        });
    }

    copyQuote(text) {
        navigator.clipboard.writeText(text).then(() => {
            // Quote copied silently
        }).catch(err => {
            console.error('Failed to copy quote:', err);
        });
    }

    copyCitation(citation) {
        navigator.clipboard.writeText(citation).then(() => {
            // Citation copied silently
        }).catch(err => {
            console.error('Failed to copy citation:', err);
        });
    }

    showTemporaryMessage(message) {
        // Create temporary message element
        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #10b981;
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 12px;
            z-index: 1000;
        `;
        messageDiv.textContent = message;
        document.body.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.remove();
        }, 2000);
    }

    setLoading(loading) {
        this.findQuotesBtn.disabled = loading;
        this.btnText.style.display = loading ? 'none' : 'block';
        this.searchIcon.style.display = loading ? 'none' : 'block';
        this.loadingSpinner.style.display = loading ? 'block' : 'none';
    }

    showResults() {
        this.resultsSection.style.display = 'block';
    }

    hideResults() {
        this.resultsSection.style.display = 'none';
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorMessage.style.display = 'block';
        
        // Remove any previous expansion classes and add medium expansion
        const container = document.querySelector('.container');
        container.classList.remove('expanded');
        container.classList.add('medium-expanded');
    }

    hideError() {
        this.errorMessage.style.display = 'none';
    }

    saveSession(quotes, pageTitle, pageUrl) {
        try {
            const sessionData = {
                quotes: quotes,
                pageTitle: pageTitle,
                pageUrl: pageUrl,
                topic: this.topicInput.value.trim(),
                timestamp: Date.now()
            };
            localStorage.setItem(this.storageKey, JSON.stringify(sessionData));
        } catch (error) {
            console.error('Failed to save session:', error);
        }
    }

    restoreLastSession() {
        try {
            // First check for current input text (most recent)
            const currentTopic = localStorage.getItem('quotely_current_topic');
            if (currentTopic) {
                this.topicInput.value = currentTopic;
            }
            
            const saved = localStorage.getItem(this.storageKey);
            if (!saved) return;
            
            const sessionData = JSON.parse(saved);
            // Only restore if less than 24 hours old
            if (Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000) return;
            
            // Restore topic from session if no current topic
            if (!currentTopic && sessionData.topic) {
                this.topicInput.value = sessionData.topic;
            }
            
            // Restore quotes if available
            if (sessionData.quotes && sessionData.quotes.length > 0) {
                this.lastPageTitle = sessionData.pageTitle;
                this.lastPageUrl = sessionData.pageUrl;
                this.displayQuotes(sessionData.quotes, sessionData.pageTitle, sessionData.pageUrl);
            }
        } catch (error) {
            console.error('Failed to restore session:', error);
        }
    }

    checkPendingSegmentSelection() {
        try {
            const segmentState = localStorage.getItem(this.segmentStateKey);
            if (!segmentState) return;
            
            const state = JSON.parse(segmentState);
            
            // Only restore if less than 1 hour old (segment selection shouldn't persist too long)
            if (Date.now() - state.timestamp > 60 * 60 * 1000) {
                localStorage.removeItem(this.segmentStateKey);
                return;
            }
            
            // Restore topic and page info
            if (state.topic) {
                this.topicInput.value = state.topic;
            }
            if (state.pageTitle) {
                this.lastPageTitle = state.pageTitle;
            }
            if (state.pageUrl) {
                this.lastPageUrl = state.pageUrl;
            }
            
            // Restore segment selector based on type
            console.log('Restoring pending segment selection...');
            
            if (state.isPdf) {
                // Restore PDF segment selector
                console.log('Restoring PDF segment selector');
                this.showPdfSegmentSelector(state.pdfData, state.pdfUrl).then(async selectedSegmentIndex => {
                    if (selectedSegmentIndex !== null) {
                        // Request the specific segment from server
                        this.setLoading(true);
                        try {
                            const segmentResponse = await fetch(`${this.serverUrl}/api/get-pdf-segment`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    pdfUrl: state.pdfUrl,
                                    segmentIndex: selectedSegmentIndex
                                })
                            });
                            
                            if (segmentResponse.ok) {
                                const segmentData = await segmentResponse.json();
                                this.continueWithSelectedSegment(segmentData.content, state.topic);
                            } else {
                                this.showError('Failed to retrieve PDF segment. Please try again.');
                                this.setLoading(false);
                            }
                        } catch (error) {
                            console.error('Error retrieving PDF segment:', error);
                            this.showError('Failed to retrieve PDF segment. Please try again.');
                            this.setLoading(false);
                        }
                    }
                });
            } else {
                // Restore HTML segment selector
                console.log('Restoring HTML segment selector');
                this.showSegmentSelector(state.fullText, state.topic).then(selectedSegment => {
                    if (selectedSegment) {
                        // User selected a segment, continue with quote finding
                        this.continueWithSelectedSegment(selectedSegment, state.topic);
                    }
                });
            }
        } catch (error) {
            console.error('Failed to restore segment selection:', error);
            localStorage.removeItem(this.segmentStateKey);
        }
    }

    async continueWithSelectedSegment(content, topic) {
        try {
            this.setLoading(true);
            
            // Create pageData object with the selected segment
            const pageData = {
                content: content,
                title: this.lastPageTitle || 'Current Page',
                url: this.lastPageUrl || window.location.href
            };
            
            this.lastPageTitle = pageData.title;
            this.lastPageUrl = pageData.url;
            
            console.log('=== FIND QUOTES: Content Length Check ===');
            console.log('Content length to send:', content.length, 'characters');
            
            // Send to server for analysis
            const response = await fetch(`${this.serverUrl}/api/find-quotes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    topic: topic,
                    pageContent: content,
                    pageUrl: this.lastPageUrl,
                    pageTitle: this.lastPageTitle
                })
            });

            if (!response.ok) {
                if (response.status === 413) {
                    this.showError('The page is too large to analyze. Try a simpler page or select text and paste it instead.');
                    return;
                }
                throw new Error(`Server error: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.quotes && data.quotes.length > 0) {
                this.lastPageTitle = data.pageTitle || this.lastPageTitle;
                this.lastPageUrl = data.pageUrl || this.lastPageUrl;
                this.displayQuotes(data.quotes, this.lastPageTitle, this.lastPageUrl);
            } else {
                this.showError('No relevant quotes found. Try a different topic or check if the page has relevant content.');
            }

        } catch (error) {
            console.error('Error finding quotes:', error);
            this.showError('Failed to find quotes. The server might be offline. Please try again later.');
        } finally {
            this.setLoading(false);
        }
    }

    saveCitationToStorage(quoteText, citationData, pageTitle, pageUrl, format, isVisible = true) {
        try {
            const citations = JSON.parse(localStorage.getItem(this.citationsKey) || '{}');
            // Use quote text as key, with page URL for uniqueness
            const citationKey = `${pageUrl}_${quoteText}`;
            
            
            citations[citationKey] = {
                data: citationData,
                pageTitle: pageTitle,
                pageUrl: pageUrl,
                format: format,
                quoteText: quoteText,
                isVisible: isVisible,
                timestamp: Date.now()
            };
            
            localStorage.setItem(this.citationsKey, JSON.stringify(citations));

        } catch (error) {
            console.error('Failed to save citation:', error);
        }
    }

    restoreCitations() {
        try {
            const citations = JSON.parse(localStorage.getItem(this.citationsKey) || '{}');
            const currentPageUrl = this.lastPageUrl;
            
            if (!currentPageUrl) return;
            
            // Find citations for current page
            Object.keys(citations).forEach(key => {
                if (key.startsWith(`${currentPageUrl}_`)) {
                    const citationInfo = citations[key];
                    const quoteText = citationInfo.quoteText;
                    const format = citationInfo.format;
                    
                    // Only restore if format matches current selection
                    if (format === this.citationFormat.value) {

                        this.displayStoredCitationByQuote(quoteText, citationInfo);
                    } else {

                    }
                }
            });
        } catch (error) {
            console.error('Failed to restore citations:', error);
        }
    }

    displayStoredCitationByQuote(quoteText, citationState) {
        // Find the quote element by text content
        const quoteElements = document.querySelectorAll('#quotes-container .quote-item');
        let targetQuote = null;
        let targetIndex = null;
        
        for (const quoteElement of quoteElements) {
            const elementQuoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
            if (elementQuoteText === quoteText) {
                targetQuote = quoteElement;
                // Get the data-index from the pin element
                const pinElement = quoteElement.querySelector('.quote-pin');
                if (pinElement) {
                    targetIndex = pinElement.getAttribute('data-index');
                }
                break;
            }
        }
        
        if (!targetQuote || !targetIndex) {

            return;
        }
        
        const citationDisplay = document.getElementById(`citation-${targetIndex}`);
        if (!citationDisplay) return;
        
        // Check if citation is already displayed to avoid duplicate restoration
        if (citationDisplay.innerHTML.trim() !== '') {

            return;
        }
        
        // Create single rounded box with both citations and copy buttons
        citationDisplay.innerHTML = `
            <div class="citation-box">
                <div class="citation-item">
                    <div class="citation-text">${citationState.citationData.citation}</div>
                    <button class="citation-copy-btn" data-citation="${citationState.citationData.citation.replace(/"/g, '&quot;')}">
                        Copy
                    </button>
                </div>
                ${citationState.citationData.inTextCitation ? `
                    <div class="citation-divider"></div>
                    <div class="citation-item">
                        <div class="citation-text">${citationState.citationData.inTextCitation.parenthetical || citationState.citationData.inTextCitation.narrative}</div>
                        <button class="citation-copy-btn" data-citation="${(citationState.citationData.inTextCitation.parenthetical || citationState.citationData.inTextCitation.narrative).replace(/"/g, '&quot;')}">
                            Copy
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
        
        // Use stored visibility state
        citationDisplay.style.display = citationState.isVisible ? 'block' : 'none';
        
        // Update the generate citation button based on visibility state
        const citationBtn = targetQuote.querySelector('.generate-citation-btn');
        if (citationBtn) {
            citationBtn.innerHTML = citationState.isVisible ? 'Hide Citation' : 'Show Citation';
        }
        
        // Add event listeners to copy buttons
        const copyBtns = citationDisplay.querySelectorAll('.citation-copy-btn');
        copyBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const citation = btn.getAttribute('data-citation');
                this.copyCitation(citation);
            });
        });
    }

    clearStoredCitations() {
        try {
            localStorage.removeItem(this.citationsKey);
        } catch (error) {
            console.error('Failed to clear stored citations:', error);
        }
    }

    clearStoredPins() {
        try {
            localStorage.removeItem('quotely_pinned');
        } catch (error) {
            console.error('Failed to clear stored pins:', error);
        }
    }

    appendPinnedQuotesFromOtherSites() {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            const currentUrl = this.lastPageUrl;
            
            
            // Show ALL pinned quotes (from all sites, including current site)
            
            if (pinned.length === 0) {
                return;
            }
            
            // Create quote elements for ALL pinned quotes
            pinned.forEach((pinnedQuote, index) => {
                const quoteElement = this.createPinnedQuoteElement(pinnedQuote, `pinned-${index}`);
                this.quotesContainer.appendChild(quoteElement);
            });
            
        } catch (error) {
            console.error('Failed to append pinned quotes from other sites:', error);
        }
    }

    createPinnedQuoteElement(pinnedQuote, uniqueId) {
        const quoteDiv = document.createElement('div');
        quoteDiv.className = 'quote-item pinned';
        quoteDiv.setAttribute('data-pinned-id', uniqueId);
        
        quoteDiv.innerHTML = `
            <div class="quote-pin" data-pinned-id="${uniqueId}" style="opacity: 1;">
                <img src="../media/Pin.png" alt="Pin" style="width: 16px; height: 19px;">
            </div>
            <div class="quote-text">"${pinnedQuote.quote}"</div>
            <div class="quote-actions">
                <button class="action-btn copy-btn" data-quote="${pinnedQuote.quote.replace(/"/g, '&quot;')}">
                    Copy Quote
                </button>
                <button class="action-btn generate-citation-btn" data-pinned-id="${uniqueId}" data-title="${pinnedQuote.pageTitle.replace(/"/g, '&quot;')}" data-url="${pinnedQuote.url.replace(/"/g, '&quot;')}">
                    Generate Citation
                </button>
                <div class="quote-help" data-help="Pinned from ${pinnedQuote.pageTitle}">
                    <img src="../media/Question Mark.png" alt="?" style="width: 16px; height: 16px;">
                </div>
            </div>
            <div class="citation-display" id="citation-${uniqueId}" style="display: none;"></div>
        `;

        // Add event listeners
        const copyBtn = quoteDiv.querySelector('.copy-btn');
        const citationBtn = quoteDiv.querySelector('.generate-citation-btn');
        const pinBtn = quoteDiv.querySelector('.quote-pin');
        
        copyBtn.addEventListener('click', () => {
            const quote = copyBtn.getAttribute('data-quote');
            this.copyQuote(quote);
            
            // Add pop animation
            copyBtn.classList.add('pop-animation');
            setTimeout(() => {
                copyBtn.classList.remove('pop-animation');
            }, 300);
        });
        
        pinBtn.addEventListener('click', () => {
            this.removePinnedQuote(uniqueId, pinnedQuote.quote);
        });
        
        citationBtn.addEventListener('click', () => {
            const pinnedId = citationBtn.getAttribute('data-pinned-id');
            const title = citationBtn.getAttribute('data-title');
            const url = citationBtn.getAttribute('data-url');
            
            // Check if citation already exists
            const citationDisplay = document.getElementById(`citation-${pinnedId}`);
            if (citationDisplay && citationDisplay.innerHTML.trim() !== '') {
                // Citation exists, toggle it
                this.toggleCitation(pinnedId);
            } else {
                // No citation exists, generate new one
                this.generateCitation(pinnedId, title, url);
            }
        });
        
        // Restore citation if it exists
        if (pinnedQuote.citation) {
            const citationDisplay = quoteDiv.querySelector(`#citation-${uniqueId}`);
            if (citationDisplay) {
                citationDisplay.innerHTML = pinnedQuote.citation;
                // Use stored visibility state, default to hidden if not specified
                const isVisible = pinnedQuote.citationVisible !== false;
                citationDisplay.style.display = isVisible ? 'block' : 'none';
                citationBtn.innerHTML = isVisible ? 'Hide Citation' : 'Generate Citation';
            }
        }
        
        return quoteDiv;
    }

    removePinnedQuote(uniqueId, quoteText) {
        try {
            // Remove from DOM
            const quoteElement = document.querySelector(`[data-pinned-id="${uniqueId}"]`);
            if (quoteElement) {
                quoteElement.remove();
            }
            
            // Remove from storage
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            const updatedPinned = pinned.filter(pin => pin.quote !== quoteText);
            localStorage.setItem('quotely_pinned', JSON.stringify(updatedPinned));
            
        } catch (error) {
            console.error('Failed to remove pinned quote:', error);
        }
    }

    checkAndRestorePins() {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            
            // If we have quotes displayed, try to restore pins
            const quoteElements = document.querySelectorAll('#quotes-container .quote-item');
            if (quoteElements.length > 0 && this.lastPageUrl) {
                this.restorePinnedState();
            } else {
            }
        } catch (error) {
            console.error('Failed to check and restore pins:', error);
        }
    }

    updatePinnedStorage() {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            
            // Get all currently pinned quotes with full data
            const quoteElements = document.querySelectorAll('#quotes-container .quote-item');
            const currentlyPinned = [];
            
            quoteElements.forEach((quoteElement) => {
                if (quoteElement.classList.contains('pinned')) {
                    const pinElement = quoteElement.querySelector('.quote-pin');
                    if (pinElement) {
                        const index = parseInt(pinElement.getAttribute('data-index'));
                        const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
                        const citationDisplay = document.getElementById(`citation-${index}`);
                        const hasCitation = citationDisplay && citationDisplay.innerHTML.trim() !== '';
                        
                        const quoteData = {
                            index: index,
                            quote: quoteText,
                            url: this.lastPageUrl,
                            pageTitle: this.lastPageTitle,
                            citation: hasCitation ? citationDisplay.innerHTML : null,
                            citationVisible: hasCitation && citationDisplay.style.display !== 'none',
                            timestamp: Date.now()
                        };
                        
                        currentlyPinned.push(quoteData);
                    }
                }
            });
            
            // Update storage with current state (universal)
            localStorage.setItem('quotely_pinned', JSON.stringify(currentlyPinned));
            
        } catch (error) {
            console.error('Failed to update pinned storage:', error);
        }
    }


    toggleCitation(index) {
        const citationDisplay = document.getElementById(`citation-${index}`);
        
        // Handle both regular quotes (numeric index) and pinned quotes (string ID)
        let citationBtn;
        let quoteText;
        if (typeof index === 'string' && index.startsWith('pinned-')) {
            // For pinned quotes, find the button within the quote with the matching data-pinned-id
            citationBtn = document.querySelector(`[data-pinned-id="${index}"].generate-citation-btn`);
            const quoteElement = citationBtn?.closest('.quote-item');
            if (quoteElement) {
                quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
            }
        } else {
            // For regular quotes, find by data-index attribute
            const targetQuote = document.querySelector(`#quotes-container .quote-item .quote-pin[data-index="${index}"]`)?.closest('.quote-item');
            if (targetQuote) {
                citationBtn = targetQuote.querySelector('.generate-citation-btn');
                quoteText = targetQuote.querySelector('.quote-text').textContent.replace(/"/g, '');
            }
        }
        
        if (citationDisplay.style.display === 'none' || citationDisplay.style.display === '') {
            citationDisplay.style.display = 'block';
            citationBtn.innerHTML = 'Hide Citation';
            
            // Update quote citation state (show citation)
            this.updateQuoteCitationState(quoteText, true, true);
        } else {
            citationDisplay.style.display = 'none';
            citationBtn.innerHTML = 'Show Citation';
            
            // Update quote citation state (hide citation)
            this.updateQuoteCitationState(quoteText, true, false);
        }
    }

    // Unified quote management system
    getQuotesList() {
        try {
            return JSON.parse(localStorage.getItem(this.quotesKey) || '[]');
        } catch (error) {
            console.error('Failed to get quotes list:', error);
            return [];
        }
    }

    saveQuotesList(quotes) {
        try {
            localStorage.setItem(this.quotesKey, JSON.stringify(quotes));
        } catch (error) {
            console.error('Failed to save quotes list:', error);
        }
    }

    updateQuoteCitationState(quoteText, hasCitation, isVisible, citationData = null) {
        try {
            const quotes = this.getQuotesList();
            const currentPageUrl = this.lastPageUrl;
            
            if (!currentPageUrl) return;
            
            // Find or create quote entry
            let quoteEntry = quotes.find(q => q.quoteText === quoteText && q.pageUrl === currentPageUrl);
            
            if (!quoteEntry) {
                quoteEntry = {
                    quoteText: quoteText,
                    pageUrl: currentPageUrl,
                    pageTitle: this.lastPageTitle,
                    hasCitation: false,
                    isVisible: false,
                    citationData: null,
                    timestamp: Date.now()
                };
                quotes.push(quoteEntry);
            }
            
            // Update the entry
            quoteEntry.hasCitation = hasCitation;
            quoteEntry.isVisible = isVisible;
            if (citationData) {
                quoteEntry.citationData = citationData;
            }
            quoteEntry.timestamp = Date.now();
            
            this.saveQuotesList(quotes);

        } catch (error) {
            console.error('Failed to update quote citation state:', error);
        }
    }

    getQuoteCitationState(quoteText) {
        try {
            const quotes = this.getQuotesList();
            const currentPageUrl = this.lastPageUrl;
            
            if (!currentPageUrl) return { hasCitation: false, isVisible: false, citationData: null };
            
            const quoteEntry = quotes.find(q => q.quoteText === quoteText && q.pageUrl === currentPageUrl);
            
            if (quoteEntry) {
                return {
                    hasCitation: quoteEntry.hasCitation || false,
                    isVisible: quoteEntry.isVisible || false,
                    citationData: quoteEntry.citationData || null
                };
            }
            
            return { hasCitation: false, isVisible: false, citationData: null };
        } catch (error) {
            console.error('Failed to get quote citation state:', error);
            return { hasCitation: false, isVisible: false, citationData: null };
        }
    }

    clearCurrentPageQuotes() {
        try {
            const quotes = this.getQuotesList();
            const currentPageUrl = this.lastPageUrl;
            
            if (!currentPageUrl) return;
            
            // Remove all quotes for current page (keep pinned quotes from other pages)
            const filteredQuotes = quotes.filter(q => q.pageUrl !== currentPageUrl);
            this.saveQuotesList(filteredQuotes);

        } catch (error) {
            console.error('Failed to clear current page quotes:', error);
        }
    }

    restoreAllCitationStates() {
        try {
            const quoteElements = document.querySelectorAll('#quotes-container .quote-item');
            
            quoteElements.forEach(quoteElement => {
                const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
                const citationState = this.getQuoteCitationState(quoteText);
                
                if (citationState.hasCitation) {
                    // Restore the citation display
                    this.displayStoredCitationByQuote(quoteText, citationState);
                }
            });
 
        } catch (error) {
            console.error('Failed to restore citation states:', error);
        }
    }

    togglePin(index, pinElement) {
        const quoteElement = pinElement.closest('.quote-item');
        const isPinned = quoteElement.classList.contains('pinned');
        
        if (isPinned) {
            // Unpin
            quoteElement.classList.remove('pinned');
            pinElement.style.opacity = '0.5';
            this.removeFromPinned(index);
        } else {
            // Pin
            quoteElement.classList.add('pinned');
            pinElement.style.opacity = '1';
            this.addToPinned(index);
        }
        
        // Reorder quotes with pinned ones at top
        this.reorderQuotes();
        
        // Update storage immediately after any pin change
        this.updatePinnedStorage();
    }

    addToPinned(index) {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            
            // Get the complete quote data
            const quoteElement = document.querySelector(`#quotes-container .quote-item .quote-pin[data-index="${index}"]`)?.closest('.quote-item');
            if (!quoteElement) {
                return;
            }
            
            const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
            const citationDisplay = document.getElementById(`citation-${index}`);
            const hasCitation = citationDisplay && citationDisplay.innerHTML.trim() !== '';
            
            const quoteData = {
                index: index,
                quote: quoteText,
                url: this.lastPageUrl,
                pageTitle: this.lastPageTitle,
                citation: hasCitation ? citationDisplay.innerHTML : null,
                citationVisible: hasCitation && citationDisplay.style.display !== 'none',
                timestamp: Date.now()
            };
            
            // Check if this quote is already pinned (by quote text)
            const existingPin = pinned.find(pin => pin.quote === quoteText);
            
            if (!existingPin) {
                pinned.push(quoteData);
                localStorage.setItem('quotely_pinned', JSON.stringify(pinned));
            }
        } catch (error) {
            console.error('Failed to pin quote:', error);
        }
    }

    removeFromPinned(index) {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            
            // Get the quote text to find the pin to remove
            const quoteElement = document.querySelector(`#quotes-container .quote-item .quote-pin[data-index="${index}"]`)?.closest('.quote-item');
            if (!quoteElement) {
                return;
            }
            
            const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
            
            // Remove the pin by quote text
            const updatedPinned = pinned.filter(pin => pin.quote !== quoteText);
            localStorage.setItem('quotely_pinned', JSON.stringify(updatedPinned));
        } catch (error) {
            console.error('Failed to unpin quote:', error);
        }
    }

    reorderQuotes() {
        const container = document.getElementById('quotes-container');
        const quotes = Array.from(container.children);
        
        // Get all pinned quotes (universal)
        const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
        
        // Sort quotes: pinned first, then by original order
        quotes.sort((a, b) => {
            const aIndex = parseInt(a.querySelector('.quote-pin').getAttribute('data-index'));
            const bIndex = parseInt(b.querySelector('.quote-pin').getAttribute('data-index'));
            
            const aQuoteText = a.querySelector('.quote-text').textContent.replace(/"/g, '');
            const bQuoteText = b.querySelector('.quote-text').textContent.replace(/"/g, '');
            
            const aPinned = pinned.some(pin => pin.quote === aQuoteText);
            const bPinned = pinned.some(pin => pin.quote === bQuoteText);
            
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            return aIndex - bIndex;
        });
        
        // Re-append in new order
        quotes.forEach(quote => container.appendChild(quote));
        
        // Restore citations after reordering
        setTimeout(() => {
            this.restoreCitations();
        }, 100);
    }

    restorePinnedState() {
        try {
            const pinned = JSON.parse(localStorage.getItem('quotely_pinned') || '[]');
            
            if (pinned.length === 0) {
                return;
            }
            
            // Find all quote elements and check if they should be pinned
            // Only check quotes that are NOT already displayed as pinned elements (data-pinned-id)
            const quoteElements = document.querySelectorAll('#quotes-container .quote-item:not([data-pinned-id])');
            
            if (quoteElements.length === 0) {
                return;
            }
            
            let restoredCount = 0;
            quoteElements.forEach((quoteElement, position) => {
                const pinElement = quoteElement.querySelector('.quote-pin');
                if (pinElement) {
                    const index = parseInt(pinElement.getAttribute('data-index'));
                    const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
                    
                    
                    // Check if this quote is pinned by matching quote text (universal)
                    const pinnedQuote = pinned.find(pin => pin.quote === quoteText);
                    
                    if (pinnedQuote) {
                        quoteElement.classList.add('pinned');
                        pinElement.style.opacity = '1';
                        restoredCount++;
                        
                        // Restore citation if it exists
                        const citationDisplay = document.getElementById(`citation-${index}`);
                        if (pinnedQuote.citation && citationDisplay) {
                            citationDisplay.innerHTML = pinnedQuote.citation;
                            // Use stored visibility state, default to hidden if not specified
                            const isVisible = pinnedQuote.citationVisible !== false;
                            citationDisplay.style.display = isVisible ? 'block' : 'none';
                            
                            // Update the generate citation button based on visibility state
                            const citationBtn = quoteElement.querySelector('.generate-citation-btn');
                            if (citationBtn) {
                                citationBtn.innerHTML = isVisible ? 'Hide Citation' : 'Generate Citation';
                            }
                        }
                    }
                }
            });
            
            
            // Reorder quotes with pinned ones at top
            this.reorderQuotes();
            
            // Restore citations AFTER quotes are reordered
            this.restoreCitations();
        } catch (error) {
            console.error('Failed to restore pinned state:', error);
        }
    }
}

// Initialize the popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.quotelyPopup = new QuotelyPopup();
});
