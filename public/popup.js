// Quotely Popup Script
class QuotelyPopup {
    constructor() {
        this.serverUrl = 'https://quotely-rmgh.onrender.com';
        this.lastPageTitle = null;
        this.lastPageUrl = null;
        this.isPdfPage = false; // Track if current page is a PDF
        this.isPdfUploadMode = false; // Track if we're in PDF upload mode
        this.storageKey = 'quotely_last_session';
        this.citationsKey = 'quotely_citations';
        this.quotesKey = 'quotely_quotes'; // Unified quote list with citation state
        this.segmentStateKey = 'quotely_segment_state'; // State for pending segment selection
        this.tooltipElement = null; // For free-floating tooltip
        this.initializeElements();
        this.loadServerUrl();
        this.attachEventListeners();
        this.restoreLastSession();
        this.checkPendingSegmentSelection();
        this.checkPdfUploadMode();
        this.restoreSettingsState();
        this.restoreTheme();
        this.restoreSpecificity();

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
        this.createTooltipElement();
    }

    loadServerUrl() {
        try {
            const storedBase = localStorage.getItem('quotely_api_base');
            if (storedBase && typeof storedBase === 'string') {
                this.serverUrl = storedBase;
                return;
            }
        } catch (e) {
            // ignore localStorage errors
        }
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.get(['serverUrl'], (res) => {
                if (res && res.serverUrl) {
                    this.serverUrl = res.serverUrl;
                }
            });
        }
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
        
        // Settings button event listeners
        const settingsBtn = document.getElementById('settings-btn');
        const settingsPopup = document.getElementById('settings-popup');
        
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.toggleSettings());
        }
        
        // Theme toggle event listener
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('change', () => this.toggleTheme());
        }
        
        // Add click event to slider container and entire theme toggle to toggle checkbox
        const themeToggleContainer = document.querySelector('.theme-toggle');
        if (themeToggleContainer && themeToggle) {
            themeToggleContainer.addEventListener('click', (e) => {
                // Only toggle if clicking on the slider area, not the icons
                if (e.target.classList.contains('theme-toggle-slider') || 
                    e.target.closest('.theme-toggle-slider') ||
                    e.target.classList.contains('theme-toggle-thumb') ||
                    e.target.closest('.theme-toggle-thumb')) {
                    e.preventDefault();
                    e.stopPropagation();
                    themeToggle.checked = !themeToggle.checked;
                    // Trigger the change event
                    themeToggle.dispatchEvent(new Event('change'));
                }
            });
        }
        
        // Segmented control button click handlers
        const segmentedButtons = document.querySelectorAll('.segmented-btn');
        segmentedButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Remove active class from all buttons
                segmentedButtons.forEach(btn => btn.classList.remove('active'));
                
                // Add active class to clicked button
                button.classList.add('active');
                
                // Save the selected specificity value
                const value = button.dataset.value;
                localStorage.setItem('quotely_specificity', value);
            });
        });
        
        // Click outside to close settings
        document.addEventListener('click', (e) => {
            const settingsBtn = document.getElementById('settings-btn');
            const settingsPopup = document.getElementById('settings-popup');
            
            if (settingsPopup && settingsPopup.classList.contains('show')) {
                if (!settingsBtn.contains(e.target) && !settingsPopup.contains(e.target)) {
                    this.hideSettings();
                }
            }
        });
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
        
        // Clear any existing PDF dropzone when starting new search
        this.clearPdfDropzone();

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
            
            // Check if this is a PDF page or docviewer page
            const isPDF = tab.url && (tab.url.includes('.pdf') || tab.url.startsWith('file://') && tab.url.endsWith('.pdf'));
            const isDocviewer = tab.url && (tab.url.includes('viewer') || tab.url.includes('drive.google.com'));
            this.isPdfPage = isPDF || isDocviewer; // Store PDF/docviewer status

            let pageData;

            if (isDocviewer) {
                // For docviewer pages, always show PDF upload dropzone
                this.setLoading(false);
                const droppedFile = await this.showPdfDropzone(tab.title || 'Document Viewer');
                
                if (!droppedFile) {
                    // User cancelled or closed dropzone
                    return;
                }
                
                // Read the dropped file and convert to base64
                this.setLoading(true);
                const arrayBuffer = await droppedFile.arrayBuffer();
                const base64Pdf = btoa(
                    new Uint8Array(arrayBuffer)
                        .reduce((data, byte) => data + String.fromCharCode(byte), '')
                );
                const pdfTitle = tab.title || 'Document Viewer';
                
                // Send to server for PDF extraction
                const pdfResponse = await fetch(`${this.serverUrl}/api/extract-pdf`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        fileContent: base64Pdf,
                        title: pdfTitle,
                        isLocalFile: true
                    })
                });
                
                if (pdfResponse.ok) {
                    pageData = await pdfResponse.json();
                    // Check if PDF requires segmentation
                    if (pageData.requiresSegmentation) {
                        // Temporarily stop loading to show segment selector
                        this.setLoading(false);
                        
                        // Show segment selection UI for PDF
                        const selectedSegmentIndex = await this.showPdfSegmentSelector(pageData, pageData.url);
                        if (selectedSegmentIndex === null) {
                            // User cancelled
                            return;
                        }
                        
                        // Request the specific segment from server
                        const segmentResponse = await fetch(`${this.serverUrl}/api/get-pdf-segment`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                pdfUrl: pageData.url,
                                segmentIndex: selectedSegmentIndex
                            })
                        });
                        
                        if (!segmentResponse.ok) {
                            throw new Error(`Segment retrieval failed: ${segmentResponse.status}`);
                        }
                        
                        const segmentData = await segmentResponse.json();
                        
                        // Set pageData with the segment content
                        pageData = {
                            content: segmentData.content,
                            title: pageData.title,
                            url: pageData.url
                        };
                        
                        // Resume loading for quote finding
                        this.setLoading(true);
                    }
                } else {
                    throw new Error(`PDF extraction failed: ${pdfResponse.status}`);
                }
            } else if (isPDF) {
                // For PDFs, handle local vs remote files differently
                try {
                    let requestBody;
                    
                    // Check if it's a local file
                    if (tab.url.startsWith('file://')) {
                        // Check if we've already uploaded this PDF
                        const uploadedPdfInfo = await this.getUploadedPdfInfo(tab.url);
                        
                        let base64Pdf, pdfTitle;
                        
                        if (uploadedPdfInfo) {
                            // PDF was already uploaded, skip dropzone
                            base64Pdf = uploadedPdfInfo.fileContent;
                            pdfTitle = uploadedPdfInfo.title;
                        } else {
                            // Local PDFs require drag & drop (can't fetch due to security)
                            this.setLoading(false);
                            const droppedFile = await this.showPdfDropzone(tab.title);
                            
                            if (!droppedFile) {
                                // User cancelled or closed dropzone
                                return;
                            }
                            
                            // Read the dropped file and convert to base64
                            this.setLoading(true);
                            const arrayBuffer = await droppedFile.arrayBuffer();
                            base64Pdf = btoa(
                                new Uint8Array(arrayBuffer)
                                    .reduce((data, byte) => data + String.fromCharCode(byte), '')
                            );
                            pdfTitle = tab.title || 'Local PDF';
                            
                            // Save this PDF info for future use
                            await this.saveUploadedPdfInfo(tab.url, base64Pdf, pdfTitle);
                        }
                        
                        requestBody = {
                            fileContent: base64Pdf,
                            title: pdfTitle,
                            isLocalFile: true
                        };
                    } else {
                        // For remote PDFs, just send the URL
                        requestBody = {
                            url: tab.url,
                            title: tab.title
                        };
                    }
                    
                    const pdfResponse = await fetch(`${this.serverUrl}/api/extract-pdf`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(requestBody)
                    });
                    
                    if (pdfResponse.ok) {
                        pageData = await pdfResponse.json();
                        // Check if PDF requires segmentation
                        if (pageData.requiresSegmentation) {
                            // Temporarily stop loading to show segment selector
                            this.setLoading(false);
                            
                            // Show segment selection UI for PDF
                            const selectedSegmentIndex = await this.showPdfSegmentSelector(pageData, pageData.url);
                            if (selectedSegmentIndex === null) {
                                // User cancelled (shouldn't happen as we removed cancel button, but just in case)
                                return;
                            }
                            
                            // Request the specific segment from server
                            const segmentResponse = await fetch(`${this.serverUrl}/api/get-pdf-segment`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    pdfUrl: pageData.url,
                                    segmentIndex: selectedSegmentIndex
                                })
                            });
                            
                            if (!segmentResponse.ok) {
                                throw new Error(`Segment retrieval failed: ${segmentResponse.status}`);
                            }
                            
                            const segmentData = await segmentResponse.json();
                            
                            // Set pageData with the segment content
                            pageData = {
                                content: segmentData.content,
                                title: pageData.title,
                                url: pageData.url
                            };
                            
                            // Resume loading for quote finding
                            this.setLoading(true);
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
                    // Clear PDF upload mode if we're processing a non-PDF page
                    if (this.isPdfUploadMode) {
                        this.isPdfUploadMode = false;
                        this.clearPdfUploadState();
                        // Remove any existing PDF dropzone
                        this.clearPdfDropzone();
                    }
                    
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
                                // Check if this looks like a Project Gutenberg or similar full-text page
                                const bodyText = body.textContent.trim();
                                const isFullTextPage = bodyText.length > 200000 || 
                                    body.querySelector('h1, h2, h3') || 
                                    body.querySelector('chapter') ||
                                    bodyText.includes('Chapter') ||
                                    bodyText.includes('CHAPTER');
                                
                                if (isFullTextPage) {
                                    // For full-text pages, use the body content directly
                                    mainContent = body;
                                } else {
                                    // For regular pages, find the best content section
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

            }
            
            this.lastPageTitle = pageData.title || 'Current Page';
            this.lastPageUrl = pageData.url || 'Unknown URL';
            
            // Check if this appears to be a protected site with limited content
            if (this.isProtectedSite(pageData)) {
                this.setLoading(false);
                this.showError('This site is protected. Download the content locally or try a different page.');
                return;
            }
            
            // Check if content is very large (> 50,000 characters) - for both PDF and HTML
            if (pageData.content && pageData.content.length > 200000) {

                
                // Temporarily stop loading to show segment selector
                this.setLoading(false);
                
                // Show segment selection UI
                const selectedSegment = await this.showSegmentSelector(pageData.content);
                if (selectedSegment === null) {
                    // User cancelled

                    return;
                }
                
                
                // Replace content with selected segment
                pageData.content = selectedSegment;
                
                // Resume loading for quote finding
                this.setLoading(true);
            }
            
            // Log content length before sending

            
            // Enforce 50k character limit client-side (safety check)
            const limitedContent = (pageData.content || '').slice(0, 200000);
            

            // Get quote specificity setting
            const specificity = localStorage.getItem('quotely_specificity') || 'balanced';
            
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
                    pageTitle: this.lastPageTitle,
                    isOCR: pageData.isOCR || false,
                    fromPdf: this.isPdfPage || false, // Add flag indicating if content came from PDF
                    specificity: specificity // Include specificity setting
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
                // Add fromPdf flag to all quotes (from server response)
                const quotesWithMetadata = data.quotes.map(quote => ({
                    ...quote,
                    fromPdf: data.fromPdf !== undefined ? data.fromPdf : this.isPdfPage || false
                }));
                this.displayQuotes(quotesWithMetadata, this.lastPageTitle, this.lastPageUrl);
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

                segmentButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const index = parseInt(btn.dataset.index);
      
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
            const SEGMENT_SIZE = 200000;
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
                        <div class="segment-help js-tooltip" data-help="Very large documents are split into segments for better processing. Each segment contains at most 200k characters of the text. Select the segment that's most likely to contain quotes related to your topic.">
                            <img src="../media/Question Mark.png" alt="?" style="width: 16px; height: 16px;">
                        </div>
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
                
                // Add tooltip event listener for segment help
                const segmentHelp = this.quotesContainer.querySelector('.segment-help.js-tooltip');
                if (segmentHelp) {
                    segmentHelp.addEventListener('mouseenter', (e) => {
                        const rect = segmentHelp.getBoundingClientRect();
                        const tooltipText = segmentHelp.getAttribute('data-help');
                        // Position tooltip to the left of the question mark (bottom-left aligned)
                        const baseX = rect.left - 258; // 250px width + 8px offset to the left of the element
                        const baseY = rect.top; // Question mark's top edge (for bottom alignment calculation)
                        this.showTooltip(tooltipText, baseX, baseY);
                    });

                    segmentHelp.addEventListener('mouseleave', () => {
                        this.hideTooltip();
                    });
                }

                segmentButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const index = parseInt(btn.dataset.index);
                        const start = index * SEGMENT_SIZE;
                        const end = Math.min(start + SEGMENT_SIZE, fullText.length);
                        const selectedSegment = fullText.substring(start, end);

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

    showPdfDropzone(pdfTitle) {
        return new Promise((resolve) => {
            // Hide error message
            this.hideError();

            // Create inline dropzone UI (similar to segment selector)
            const dropzoneHTML = `
                <div class="segment-container">
                    <div class="segment-selector">
                        <p style="margin-bottom: 7px; margin-top: -10px; text-align: center;">Hey, it looks like this is a pdf. Let's upload it!</p>
                        <div class="pdf-file-drop-area" id="pdf-drop-area">
                            <span class="drop-area-text">
                                <img src="../media/Clip.png" alt="📎" style="width: auto; height: 20px; margin-right: 3px; vertical-align: middle; object-fit: contain;">
                                Drop PDF here or click to browse
                            </span>
                        </div>
                        <input type="file" id="pdf-file-input" accept=".pdf" style="display: none;">
                    </div>
                </div>
            `;

            // Place dropzone in main content area, not inside results section
            const mainContent = document.querySelector('.main-content');
            mainContent.insertAdjacentHTML('beforeend', dropzoneHTML);
            
            // Hide the results section completely for PDF upload mode
            this.resultsSection.style.display = 'none';

            // Expand container to show dropzone
            const container = document.querySelector('.container');
            container.classList.add('pdf-upload-expanded');

            // Set PDF upload mode and save to storage
            this.isPdfUploadMode = true;
            this.savePdfUploadState();

            const dropArea = mainContent.querySelector('#pdf-drop-area');
            const fileInput = mainContent.querySelector('#pdf-file-input');
            
            let dragCounter = 0;
            
            // Click to browse
            dropArea.addEventListener('click', () => {
                fileInput.click();
            });
            
            // Drag & drop event handlers
            dropArea.addEventListener('dragenter', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter++;
                dropArea.classList.add('drag-over');
            });
            
            dropArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            
            dropArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter--;
                if (dragCounter === 0) {
                    dropArea.classList.remove('drag-over');
                }
            });
            
            dropArea.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter = 0;
                dropArea.classList.remove('drag-over');
                
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    const file = files[0];
                    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
                        // Remove dropzone and collapse container
                        const dropzoneContent = mainContent.querySelector('.segment-container');
                        if (dropzoneContent) {
                            dropzoneContent.remove();
                        }
                        container.classList.remove('segment-expanded', 'pdf-upload-expanded');
                        this.hideResults();
                        this.isPdfUploadMode = false;
                        this.clearPdfUploadState();
                        resolve(file);
                    } else {
                        this.showError('Please drop a PDF file.');
                    }
                }
            });
            
            // File input handler
            fileInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files.length > 0) {
                    const file = files[0];
                    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
                        // Remove dropzone and collapse container
                        const dropzoneContent = mainContent.querySelector('.segment-container');
                        if (dropzoneContent) {
                            dropzoneContent.remove();
                        }
                        container.classList.remove('segment-expanded', 'pdf-upload-expanded');
                        this.hideResults();
                        this.isPdfUploadMode = false;
                        this.clearPdfUploadState();
                        resolve(file);
                    } else {
                        this.showError('Please select a PDF file.');
                    }
                }
            });
        });
    }

    savePdfUploadState() {
        chrome.storage.local.set({
            'quotely_pdf_upload_mode': true
        });
    }

    clearPdfUploadState() {
        chrome.storage.local.remove(['quotely_pdf_upload_mode']);
    }

    async saveUploadedPdfInfo(pdfUrl, fileContent, title) {
        try {
            await chrome.storage.local.set({
                [`quotely_uploaded_pdf_${pdfUrl}`]: {
                    fileContent: fileContent,
                    title: title,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            console.error('Failed to cache PDF:', error);
        }
    }

    async getUploadedPdfInfo(pdfUrl) {
        try {
            const result = await chrome.storage.local.get([`quotely_uploaded_pdf_${pdfUrl}`]);
            const pdfInfo = result[`quotely_uploaded_pdf_${pdfUrl}`];
            
            if (pdfInfo) {
                // Check if cache is still fresh (24 hours)
                const age = Date.now() - pdfInfo.timestamp;
                if (age < 24 * 60 * 60 * 1000) {
                    return pdfInfo;
                } else {
                    // Cache expired, remove it
                    await chrome.storage.local.remove([`quotely_uploaded_pdf_${pdfUrl}`]);
                    return null;
                }
            }
            return null;
        } catch (error) {
            console.error('Failed to get cached PDF:', error);
            return null;
        }
    }

    clearPdfDropzone() {
        // Remove any existing PDF dropzone from main content
        const mainContent = document.querySelector('.main-content');
        const dropzoneContent = mainContent.querySelector('.segment-container');
        if (dropzoneContent) {
            dropzoneContent.remove();
        }
        
        // Collapse container if it was expanded
        const container = document.querySelector('.container');
        container.classList.remove('segment-expanded', 'pdf-upload-expanded');
    }

    checkPdfUploadMode() {
        chrome.storage.local.get(['quotely_pdf_upload_mode'], (result) => {
            if (result.quotely_pdf_upload_mode) {
                // Hide results section and restore PDF upload mode
                this.hideResults();
                this.isPdfUploadMode = true;
                this.showPdfDropzone('Local PDF');
            }
        });
    }

    createTooltipElement() {
        // Create a single tooltip element for free-floating positioning
        this.tooltipElement = document.createElement('div');
        this.tooltipElement.className = 'free-floating-tooltip';
        this.tooltipElement.style.cssText = `
            position: fixed;
            background: #111827;
            color: #ffffff;
            padding: 10px 14px;
            border: 1px solid #374151;
            font-size: 13px;
            line-height: 1.4;
            max-width: 250px;
            min-width: 240px;
            white-space: normal;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            border-radius: 6px;
            z-index: 1000;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.12s ease;
            display: none;
        `;
        document.body.appendChild(this.tooltipElement);
    }

    showTooltip(text, baseX, baseY) {
        // Create a temporary measurement element to calculate height
        const measureDiv = document.createElement('div');
        measureDiv.style.cssText = `
            position: absolute;
            visibility: hidden;
            width: 240px;
            max-width: 250px;
            padding: 10px 14px;
            font-size: 13px;
            line-height: 1.4;
            white-space: normal;
            border: 1px solid #374151;
            background: #111827;
            color: #ffffff;
            z-index: -1;
        `;
        measureDiv.textContent = text;
        document.body.appendChild(measureDiv);

        // Get the actual height after rendering
        const tooltipHeight = measureDiv.offsetHeight;
        document.body.removeChild(measureDiv);

    // Position tooltip so its bottom aligns with the question mark's top
    const tooltipX = baseX;
    const tooltipY = baseY - tooltipHeight + 31; // 18px gap above question mark (moved down 10px)

        this.tooltipElement.textContent = text;
        this.tooltipElement.style.left = tooltipX + 'px';
        this.tooltipElement.style.top = tooltipY + 'px';
        this.tooltipElement.style.display = 'block';
        this.tooltipElement.style.opacity = '1';
    }

    hideTooltip() {
        this.tooltipElement.style.opacity = '0';
        setTimeout(() => {
            this.tooltipElement.style.display = 'none';
        }, 120);
    }

    // extractPageContent removed; using inline function via chrome.scripting.executeScript

    displayQuotes(quotes, pageTitle, pageUrl) {
        this.quotesContainer.innerHTML = '';
        
        // Update quote count
        const quoteCountElement = document.getElementById('quote-count');
        if (quoteCountElement) {
            quoteCountElement.textContent = `(${quotes.length})`;
        }
        
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
            const quoteElement = this.createQuoteElement(quoteData, index, pageTitle, pageUrl, quoteData.fromPdf);
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

    createQuoteElement(quoteData, index, pageTitle, pageUrl, fromPdf = false) {
        const quoteDiv = document.createElement('div');
        quoteDiv.className = 'quote-item';

        const quoteText = quoteData.quote || quoteData;
        const relevance = quoteData.relevance || 'Relevant to topic';

        // Conditionally render citation button based on whether it's from a PDF
        const citationButtonHTML = fromPdf ?
            `<button class="action-btn generate-citation-btn pdf-no-citation" disabled>Citation Unavailable</button>` :
            `<button class="action-btn generate-citation-btn" data-index="${index}" data-title="${pageTitle.replace(/"/g, '&quot;')}" data-url="${pageUrl.replace(/"/g, '&quot;')}">
                Generate Citation
            </button>`;

        // Special handling for first quote - use JS tooltip instead of CSS tooltip
        const isFirstQuote = index === 0;
        const helpElementHTML = isFirstQuote ?
            `<div class="quote-help js-tooltip" data-help="${relevance.replace(/"/g, '&quot;')}">
                <img src="../media/Question Mark.png" alt="?" style="width: 16px; height: 16px;">
            </div>` :
            `<div class="quote-help" data-help="${relevance.replace(/"/g, '&quot;')}">
                <img src="../media/Question Mark.png" alt="?" style="width: 16px; height: 16px;">
            </div>`;

        quoteDiv.innerHTML = `
            <div class="quote-pin" data-index="${index}" data-from-pdf="${fromPdf}">
                <img src="../media/Pin.png" alt="Pin" style="width: 16px; height: 19px;">
            </div>
            <div class="quote-text">"${quoteText}"</div>
            <div class="quote-actions">
                <button class="action-btn copy-btn" data-quote="${quoteText.replace(/"/g, '&quot;')}">
                    Copy Quote
                </button>
                ${citationButtonHTML}
                ${helpElementHTML}
            </div>
            <div class="citation-display" id="citation-${index}" style="display: none;"></div>
        `;
        
        // Add event listeners to the buttons
        const copyBtn = quoteDiv.querySelector('.copy-btn');
        const citationBtn = quoteDiv.querySelector('.generate-citation-btn');
        const pinBtn = quoteDiv.querySelector('.quote-pin');
        const helpElement = quoteDiv.querySelector('.quote-help');

        // Add ClickSpark effect to copy button
        ClickSpark({
            sparkColor: '#4287f5',
            sparkSize: 15,
            sparkRadius: 65,
            sparkCount: 12,
            duration: 300,
            children: copyBtn
        });

        copyBtn.addEventListener('click', () => {
            const quote = copyBtn.getAttribute('data-quote');
            this.copyQuote(quote);
        });

        pinBtn.addEventListener('click', () => {
            const index = parseInt(pinBtn.getAttribute('data-index'));
            this.togglePin(index, pinBtn);
        });

        if (citationBtn && !citationBtn.classList.contains('pdf-no-citation')) {
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
        }

        // Special handling for first quote JS tooltip
        if (helpElement && helpElement.classList.contains('js-tooltip')) {
            helpElement.addEventListener('mouseenter', (e) => {
                const rect = helpElement.getBoundingClientRect();
                const tooltipText = helpElement.getAttribute('data-help');
                // Position tooltip to the left of the question mark (bottom-left aligned)
                const baseX = rect.left - 258; // 250px width + 8px offset to the left of the element
                const baseY = rect.top; // Question mark's top edge (for bottom alignment calculation)
                this.showTooltip(tooltipText, baseX, baseY);
            });

            helpElement.addEventListener('mouseleave', () => {
                this.hideTooltip();
            });
        }

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
            // Ensure all quotes have the fromPdf flag before saving
            const quotesWithPdfFlag = quotes.map(quote => ({
                ...quote,
                fromPdf: quote.fromPdf !== undefined ? quote.fromPdf : false
            }));

            const sessionData = {
                quotes: quotesWithPdfFlag,
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
                // Ensure fromPdf flag exists for all quotes
                const quotesWithPdfFlag = sessionData.quotes.map(quote => ({
                    ...quote,
                    fromPdf: quote.fromPdf !== undefined ? quote.fromPdf : false
                }));
                this.displayQuotes(quotesWithPdfFlag, sessionData.pageTitle, sessionData.pageUrl);
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
            
            if (state.isPdf) {
                // Restore PDF segment selector
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
            
            // Get quote specificity setting
            const specificity = localStorage.getItem('quotely_specificity') || 'balanced';
            
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
                    pageTitle: this.lastPageTitle,
                    isOCR: false, // Segments are from regular extraction, not OCR
                    fromPdf: this.isPdfPage || false, // Add flag indicating if content came from PDF
                    specificity: specificity // Include specificity setting
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
                // Add fromPdf flag to all quotes (from server response)
                const quotesWithMetadata = data.quotes.map(quote => ({
                    ...quote,
                    fromPdf: data.fromPdf !== undefined ? data.fromPdf : this.isPdfPage || false
                }));
                this.displayQuotes(quotesWithMetadata, this.lastPageTitle, this.lastPageUrl);
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
        
        // Check if quote is from PDF to conditionally render citation button
        const fromPdf = pinnedQuote.fromPdf || false;
        const citationButtonHTML = fromPdf ?
            `<button class="action-btn generate-citation-btn pdf-no-citation" disabled>Citation Unavailable</button>` :
            `<button class="action-btn generate-citation-btn" data-pinned-id="${uniqueId}" data-title="${pinnedQuote.pageTitle.replace(/"/g, '&quot;')}" data-url="${pinnedQuote.url.replace(/"/g, '&quot;')}">
                Generate Citation
            </button>`;
        
        quoteDiv.innerHTML = `
            <div class="quote-pin" data-pinned-id="${uniqueId}" data-from-pdf="${fromPdf}" style="opacity: 1;">
                <img src="../media/Pin.png" alt="Pin" style="width: 16px; height: 19px;">
            </div>
            <div class="quote-text">"${pinnedQuote.quote}"</div>
            <div class="quote-actions">
                <button class="action-btn copy-btn" data-quote="${pinnedQuote.quote.replace(/"/g, '&quot;')}">
                    Copy Quote
                </button>
                ${citationButtonHTML}
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
        
        // Add ClickSpark effect to pinned copy button
        ClickSpark({
            sparkColor: '#4287f5',
            sparkSize: 15,
            sparkRadius: 65,
            sparkCount: 12,
            duration: 300,
            children: copyBtn
        });

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
        
        if (citationBtn && !citationBtn.classList.contains('pdf-no-citation')) {
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
        }
        
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
                        const fromPdf = pinElement.getAttribute('data-from-pdf') === 'true';
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
                            fromPdf: fromPdf,
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
            
            const pinElement = quoteElement.querySelector('.quote-pin');
            const fromPdf = pinElement.getAttribute('data-from-pdf') === 'true';
            
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
                fromPdf: fromPdf,
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
        
        // Sort quotes: pinned first, then by score-based order (already sorted by server)
        quotes.sort((a, b) => {
            const aQuoteText = a.querySelector('.quote-text').textContent.replace(/"/g, '');
            const bQuoteText = b.querySelector('.quote-text').textContent.replace(/"/g, '');
            
            const aPinned = pinned.some(pin => pin.quote === aQuoteText);
            const bPinned = pinned.some(pin => pin.quote === bQuoteText);
            
            // Pinned quotes first
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            
            // For non-pinned quotes, maintain server's score-based order
            // (quotes are already sorted by relevance score from server)
            return 0;
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

    isProtectedSite(pageData) {
        if (!pageData || !pageData.content) {
            return true;
        }
        
        const content = pageData.content.toLowerCase();
        const contentLength = pageData.content.length;
        
        // If content is more than 400 characters, it's considered legitimate
        if (contentLength > 400) {
            return false;
        }
        
        // If content is 400 characters or less, check for protection indicators
        const protectedIndicators = [
            'sign in to continue',
            'log in to access',
            'subscription required',
            'premium content',
            'paywall',
            'please log in',
            'access denied',
            'members only',
            'subscribe to read',
            'login required',
            'authentication required',
            'please sign in',
            'register to continue',
            '0:000:00',
            'want to print',
            'create account',
            'free trial',
            'upgrade to premium',
            'content locked',
            'restricted access',
            'login to view',
            'sign up to read',
            'subscription needed',
            'premium subscription',
            'unlock this article',
            'continue reading with',
            'read more with subscription',
            'limited preview',
            'sample content only',
            'partial content',
            'excerpt only'
        ];
        
        // Check if content contains any protected site indicators
        for (const indicator of protectedIndicators) {
            if (content.includes(indicator)) {
                return true;
            }
        }
        
        // Check for strong paywall patterns
        const strongPaywallPatterns = [
            /you have reached your.*free.*article.*limit/i,
            /free articles remaining/i,
            /subscribe to continue reading/i,
            /unlock.*articles.*with.*subscription/i,
            /premium.*subscription.*required/i,
            /members.*only.*content/i,
            /login.*required.*to.*view/i,
            /sign.*in.*to.*continue.*reading/i
        ];
        
        for (const pattern of strongPaywallPatterns) {
            if (pattern.test(content)) {
                return true;
            }
        }
        
        return false;
    }

    showSettings() {
        const settingsPopup = document.getElementById('settings-popup');
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsPopup) {
            settingsPopup.classList.add('show');
        }
        if (settingsBtn) {
            settingsBtn.classList.add('rotated');
        }
        // Save settings state
        localStorage.setItem('quotely_settings_open', 'true');
    }

    hideSettings() {
        const settingsPopup = document.getElementById('settings-popup');
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsPopup) {
            settingsPopup.classList.remove('show');
        }
        if (settingsBtn) {
            settingsBtn.classList.remove('rotated');
        }
        // Save settings state
        localStorage.setItem('quotely_settings_open', 'false');
    }

    toggleSettings() {
        const settingsPopup = document.getElementById('settings-popup');
        if (settingsPopup && settingsPopup.classList.contains('show')) {
            this.hideSettings();
        } else {
            this.showSettings();
        }
    }

    restoreSettingsState() {
        try {
            const settingsOpen = localStorage.getItem('quotely_settings_open');
            if (settingsOpen === 'true') {
                this.showSettings();
            }
        } catch (error) {
            console.error('Failed to restore settings state:', error);
        }
    }

    toggleTheme() {
        const themeToggle = document.getElementById('theme-toggle');
        const isDarkMode = themeToggle.checked;
        
        // Save theme preference
        localStorage.setItem('quotely_dark_mode', isDarkMode ? 'true' : 'false');
        
        // Apply dark mode to the popup
        this.applyTheme(isDarkMode);
        
        console.log('Theme toggle:', isDarkMode ? 'Dark Mode' : 'Light Mode');
    }

    applyTheme(isDarkMode) {
        const container = document.querySelector('.container');
        if (isDarkMode) {
            container.classList.add('dark-mode');
        } else {
            container.classList.remove('dark-mode');
        }
    }

    restoreTheme() {
        try {
            const darkMode = localStorage.getItem('quotely_dark_mode');
            const isDarkMode = darkMode === 'true';
            
            // Set the toggle state
            const themeToggle = document.getElementById('theme-toggle');
            if (themeToggle) {
                themeToggle.checked = isDarkMode;
            }
            
            // Apply the theme
            this.applyTheme(isDarkMode);
        } catch (error) {
            console.error('Failed to restore theme:', error);
        }
    }

    restoreSpecificity() {
        try {
            const specificity = localStorage.getItem('quotely_specificity');
            if (specificity) {
                // Find the button with matching data-value
                const segmentedButtons = document.querySelectorAll('.segmented-btn');
                segmentedButtons.forEach(button => {
                    if (button.dataset.value === specificity) {
                        // Remove active class from all buttons
                        segmentedButtons.forEach(btn => btn.classList.remove('active'));
                        // Add active class to the matching button
                        button.classList.add('active');
                    }
                });
            }
        } catch (error) {
            console.error('Failed to restore specificity:', error);
        }
    }
}

// Initialize the popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.quotelyPopup = new QuotelyPopup();
});
