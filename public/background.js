// Quotely Background Script
// Handles extension lifecycle and communication

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Quotely extension installed');
        
        // Set up default storage values
        chrome.storage.sync.set({
            citationFormat: 'MLA',
            serverUrl: 'https://quotely-rmgh.onrender.com'
        });
    }
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
    // This is handled by the popup, but we can add additional logic here if needed
    console.log('Quotely extension clicked on tab:', tab.url);
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getTabInfo') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                sendResponse({
                    url: tabs[0].url,
                    title: tabs[0].title,
                    id: tabs[0].id
                });
            }
        });
        return true; // Keep the message channel open
    }
});

