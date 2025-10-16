// Quotely Background Script
// Handles extension lifecycle and communication

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.storage.sync.set({
            citationFormat: 'MLA',
            serverUrl: 'http:localhost:3000' //https://quotely-rmgh.onrender.com
        });
    }
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

