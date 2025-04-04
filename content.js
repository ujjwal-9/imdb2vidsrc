// Add VidSrc button to IMDb links
function addVidsrcButton(link) {
  if (link.vidsrcButton) return; // Skip if button already added
  
  // Only process IMDb links
  if (!link.href.includes('imdb.com/title/')) return;
  
  const imdbId = link.href.match(/\/title\/(tt\d+)/)?.[1];
  if (!imdbId) return;

  // Mark the link as processed to avoid duplicate buttons
  link.vidsrcButton = true;

  // Create the button with all styling and functionality
  const button = document.createElement('a');
  button.textContent = '▶ Watch';
  button.style.cssText = `
    margin-left: 5px;
    padding: 2px 6px;
    background: #f50;
    color: white;
    border-radius: 3px;
    font-size: 12px;
    text-decoration: none;
    cursor: pointer;
  `;
  
  // Add click handler directly during creation
  button.addEventListener('click', (e) => {
    e.preventDefault();
    
    // Store the IMDb ID for the popup to use
    chrome.storage.local.set({ lastClickedImdbId: imdbId }, () => {
      // Determine if we're on IMDb page or elsewhere
      if (window.location.href.includes('imdb.com/title/')) {
        chrome.runtime.sendMessage({
          action: 'checkContentType',
          imdbId: imdbId
        }, (response) => {
          if (response?.type === 'TVSeries' || response?.type === 'TVEpisode') {
            // TV series: open the popup for season/episode selection
            chrome.runtime.sendMessage({ action: 'openPopup' });
          } else {
            // Movie: navigate directly
            window.open(`https://vidsrc.icu/embed/movie/${imdbId}`, '_blank');
          }
        });
      } else {
        // Not on IMDb directly, use popup for content detection
        chrome.runtime.sendMessage({ action: 'openPopup' });
      }
    });
  });
  
  link.parentNode.insertBefore(button, link.nextSibling);
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getImdbInfo') {
    // Extract IMDb ID from the current page
    const imdbId = window.location.href.match(/\/title\/(tt\d+)/)?.[1];
    sendResponse({ 
      imdbId: imdbId, 
      success: !!imdbId,
      message: imdbId ? undefined : 'Not on an IMDb page'
    });
    return true;
  }
  return true; // Keep the message channel open for asynchronous responses
});

// Efficiently process page load and mutations
function processImdbLinks(container = document) {
  container.querySelectorAll('a[href*="imdb.com/title/"]').forEach(addVidsrcButton);
}

// Initial processing
processImdbLinks();

// Observe DOM changes for dynamically added links
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) { // Element node
          if (node.matches('a[href*="imdb.com/title/"]')) {
            addVidsrcButton(node);
          } else {
            processImdbLinks(node);
          }
        }
      });
    }
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
}); 