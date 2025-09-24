// Quotely Popup Script
class QuotelyPopup {
    constructor() {
        this.serverUrl = 'https://your-actual-render-url.onrender.com';
        this.lastPageTitle = null;
        this.lastPageUrl = null;
        this.storageKey = 'quotely_last_session';
        this.citationsKey = 'quotely_citations';
        this.initializeElements();
        this.attachEventListeners();
        this.restoreLastSession();
        
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

        // Clear stored citations when starting a new search (but keep pins)
        this.clearStoredCitations();

        // Collapse the container when starting a new search
        const container = document.querySelector('.container');
        container.classList.remove('expanded', 'medium-expanded');

        this.setLoading(true);
        this.hideError();
        this.hideResults();

        try {
            // Get current tab information
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            // Inject function into the page to extract content
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => ({
                    content: document && document.body ? document.body.innerText : (document && document.documentElement ? document.documentElement.textContent : null),
                    url: window && window.location ? window.location.href : null,
                    title: document ? document.title : null
                })
            }).catch(() => []);

            if (!results || results.length === 0 || !results[0] || !results[0].result || !results[0].result.content) {
                this.showError('Cannot access this page content (restricted page like chrome:// or extension page). Try another tab.');
                return;
            }

            const pageData = results[0].result;
            this.lastPageTitle = pageData.title || 'Current Page';
            this.lastPageUrl = pageData.url || 'Unknown URL';
            
            // Enforce 10k character limit client-side
            const limitedContent = (pageData.content || '').slice(0, 10000);

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

    // extractPageContent removed; using inline function via chrome.scripting.executeScript

    displayQuotes(quotes, pageTitle, pageUrl) {
        this.quotesContainer.innerHTML = '';
        
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
        // Restore any existing citations for this page
        this.restoreCitations();
        
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
        const quoteElement = document.querySelector(`#quotes-container .quote-item:nth-child(${index + 1})`);
        const quoteText = quoteElement.querySelector('.quote-text').textContent.replace(/"/g, '');
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
                
                // Save citation to storage
                this.saveCitationToStorage(index, data, pageTitle, pageUrl, format);
                
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

    saveCitationToStorage(index, citationData, pageTitle, pageUrl, format) {
        try {
            const citations = JSON.parse(localStorage.getItem(this.citationsKey) || '{}');
            const citationKey = `${pageUrl}_${index}_${format}`;
            
            citations[citationKey] = {
                data: citationData,
                pageTitle: pageTitle,
                pageUrl: pageUrl,
                format: format,
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
                    const index = key.split('_')[1];
                    const format = citationInfo.format;
                    
                    // Only restore if format matches current selection
                    if (format === this.citationFormat.value) {
                        this.displayStoredCitation(parseInt(index), citationInfo.data);
                    }
                }
            });
        } catch (error) {
            console.error('Failed to restore citations:', error);
        }
    }

    displayStoredCitation(index, citationData) {
        const citationDisplay = document.getElementById(`citation-${index}`);
        if (!citationDisplay) return;
        
        // Create single rounded box with both citations and copy buttons
        citationDisplay.innerHTML = `
            <div class="citation-box">
                <div class="citation-item">
                    <div class="citation-text">${citationData.citation}</div>
                    <button class="citation-copy-btn" data-citation="${citationData.citation.replace(/"/g, '&quot;')}">
                        Copy
                    </button>
                </div>
                ${citationData.inTextCitation ? `
                    <div class="citation-divider"></div>
                    <div class="citation-item">
                        <div class="citation-text">${citationData.inTextCitation.parenthetical || citationData.inTextCitation.narrative}</div>
                        <button class="citation-copy-btn" data-citation="${(citationData.inTextCitation.parenthetical || citationData.inTextCitation.narrative).replace(/"/g, '&quot;')}">
                            Copy
                        </button>
                    </div>
                ` : ''}
            </div>
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
        
        // Update the generate citation button to show "Hide Citation"
        const citationBtn = document.querySelector(`#quotes-container .quote-item:nth-child(${index + 1}) .generate-citation-btn`);
        if (citationBtn) {
            citationBtn.innerHTML = 'Hide Citation';
        }
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
                citationDisplay.style.display = 'block';
                citationBtn.innerHTML = 'Hide Citation';
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
        const citationBtn = document.querySelector(`#quotes-container .quote-item:nth-child(${index + 1}) .generate-citation-btn`);
        
        if (citationDisplay.style.display === 'none' || citationDisplay.style.display === '') {
            citationDisplay.style.display = 'block';
            citationBtn.innerHTML = 'Hide Citation';
        } else {
            citationDisplay.style.display = 'none';
            citationBtn.innerHTML = 'Show Citation';
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
            const quoteElement = document.querySelector(`#quotes-container .quote-item:nth-child(${index + 1})`);
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
            const quoteElement = document.querySelector(`#quotes-container .quote-item:nth-child(${index + 1})`);
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
                            citationDisplay.style.display = 'block';
                            
                            // Update the generate citation button to show "Hide Citation"
                            const citationBtn = quoteElement.querySelector('.generate-citation-btn');
                            if (citationBtn) {
                                citationBtn.innerHTML = 'Hide Citation';
                            }
                        }
                    }
                }
            });
            
            
            // Reorder quotes with pinned ones at top
            this.reorderQuotes();
        } catch (error) {
            console.error('Failed to restore pinned state:', error);
        }
    }
}

// Initialize the popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.quotelyPopup = new QuotelyPopup();
});
