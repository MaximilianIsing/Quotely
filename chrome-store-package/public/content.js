// Quotely Content Script
// Guard against multiple injections and avoid leaking global class names
(function () {
    if (window.__QUOTELY_CONTENT_INIT__) {
        return; // Already initialized
    }
    window.__QUOTELY_CONTENT_INIT__ = true;

    class ContentScriptController {
        constructor() {
            this.highlightedElements = [];
            this.initializeContentScript();
        }

        initializeContentScript() {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                if (request.action === 'extractPageContent') {
                    this.extractPageContent().then(sendResponse);
                    return true; // Keep the message channel open for async response
                }
            });
        }

        async extractPageContent() {
            try {
                const content = this.getMainContent();
                return {
                    content: content,
                    url: window.location.href,
                    title: document.title,
                    timestamp: new Date().toISOString()
                };
            } catch (error) {
                console.error('Error extracting page content:', error);
                return {
                    content: document.documentElement.outerHTML,
                    url: window.location.href,
                    title: document.title,
                    error: error.message
                };
            }
        }

        getMainContent() {
            const mainSelectors = [
                'main',
                'article',
                '[role="main"]',
                '.content',
                '#content',
                '.main-content',
                '.post-content',
                '.entry-content'
            ];

            for (const selector of mainSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim().length > 100) {
                    return element.outerHTML;
                }
            }
            return document.body.outerHTML;
        }

        highlightQuote(quoteText) {
            this.removeHighlights();
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );

            let node;
            while (node = walker.nextNode()) {
                if (node.textContent.includes(quoteText)) {
                    const parent = node.parentNode;
                    if (parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE') {
                        const highlightedHTML = node.textContent.replace(
                            new RegExp(quoteText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                            `<mark class="quotely-highlight">$&</mark>`
                        );
                        if (highlightedHTML !== node.textContent) {
                            const wrapper = document.createElement('div');
                            wrapper.innerHTML = highlightedHTML;
                            parent.replaceChild(wrapper, node);
                            this.highlightedElements.push(wrapper);
                        }
                    }
                }
            }
        }

        removeHighlights() {
            this.highlightedElements.forEach(element => {
                const parent = element.parentNode;
                if (parent) {
                    parent.replaceChild(document.createTextNode(element.textContent), element);
                    parent.normalize();
                }
            });
            this.highlightedElements = [];
        }
    }

    // Expose a single instance if needed later
    window.quotelyContentScript = new ContentScriptController();
})();
