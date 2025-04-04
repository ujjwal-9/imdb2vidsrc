// Add VidSrc button to IMDb links
function addVidsrcButton(link) {
  // Skip if button already added or if the parent already has a vidsrc button
  if (link.vidsrcButton || link.parentNode?.querySelector('.vidsrc-watch-button')) return;
  
  // Only process IMDb links
  if (!link.href || !link.href.includes('imdb.com/title/')) return;
  
  const imdbId = link.href.match(/\/title\/(tt\d+)/)?.[1];
  if (!imdbId) return;

  // Mark the link as processed to avoid duplicate buttons
  link.vidsrcButton = true;

  // Create the button with all styling and functionality
  const button = document.createElement('a');
  button.textContent = '▶ Watch';
  button.className = 'vidsrc-watch-button'; // Add a class for easier identification
  button.style.cssText = `
    margin-left: 5px;
    padding: 2px 6px;
    background: #f50;
    color: white;
    border-radius: 3px;
    font-size: 12px;
    text-decoration: none;
    cursor: pointer;
    display: inline-block;
  `;
  
  // Add click handler directly during creation
  button.addEventListener('click', (e) => {
    e.preventDefault();
    
    try {
      // Store the IMDb ID for the popup to use
      chrome.storage.local.set({ lastClickedImdbId: imdbId }, () => {
        // Open the extension popup or directly navigate to vidsrc
        if (chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ 
            action: 'openPopup', 
            imdbId: imdbId 
          }).catch(error => {
            console.log('Failed to send message:', error);
            // Fallback: open vidsrc directly
            openVidsrc(imdbId);
          });
        } else {
          // Runtime not available, open vidsrc directly
          openVidsrc(imdbId);
        }
      });
    } catch (error) {
      console.log('Extension context error:', error);
      // Fallback: open vidsrc directly without using extension APIs
      openVidsrc(imdbId);
    }
  });
  
  // Append the button to the link
  link.parentNode.insertBefore(button, link.nextSibling);
}

// Fallback function to open vidsrc directly
function openVidsrc(imdbId) {
  // Use a default domain when extension context is invalid
  window.open(`https://vidsrc.to/embed/movie/${imdbId}`, '_blank');
}

// Main function to process the page
function processPage() {
  try {
    // Find only IMDb title links on the page for better performance
    const links = document.querySelectorAll('a[href*="imdb.com/title/"]');
    
    // Process each link
    links.forEach(link => {
      // Skip links that already have buttons
      if (!link.vidsrcButton && !link.parentNode?.querySelector('.vidsrc-watch-button')) {
        addVidsrcButton(link);
      }
    });
    
    // Set up a mutation observer to handle dynamically added links
    if (!window.vidsrcObserver) {
      window.vidsrcObserver = new MutationObserver((mutations) => {
        // Create a set to store unique IMDb links found in this batch
        const newLinks = new Set();
        
        for (const mutation of mutations) {
          if (mutation.addedNodes.length) {
            mutation.addedNodes.forEach(node => {
              // Process only if it's an element node
              if (node.nodeType === 1) { // ELEMENT_NODE
                // If the node itself is an IMDb link
                if (node.tagName === 'A' && node.href && 
                    node.href.includes('imdb.com/title/') && 
                    !node.vidsrcButton && 
                    !node.parentNode?.querySelector('.vidsrc-watch-button')) {
                  newLinks.add(node);
                }
                
                // Check for IMDb links inside the added node
                if (node.querySelectorAll) {
                  const childLinks = node.querySelectorAll('a[href*="imdb.com/title/"]');
                  childLinks.forEach(link => {
                    if (!link.vidsrcButton && !link.parentNode?.querySelector('.vidsrc-watch-button')) {
                      newLinks.add(link);
                    }
                  });
                }
              }
            });
          }
        }
        
        // Process the unique links we found
        newLinks.forEach(addVidsrcButton);
      });
      
      // Start observing the document with the configured parameters
      window.vidsrcObserver.observe(document.body, { 
        childList: true, 
        subtree: true 
      });
    }
  } catch (error) {
    console.log('Error in processPage:', error);
  }
}

// Run the main function after DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', processPage);
} else {
  processPage();
}

// Handle extension context invalidation
window.addEventListener('error', (event) => {
  if (event.error && event.error.message && 
      event.error.message.includes('Extension context invalidated')) {
    console.log('Extension context was invalidated. Some functionality may be limited.');
    
    // Clean up observer if it exists
    if (window.vidsrcObserver) {
      window.vidsrcObserver.disconnect();
      window.vidsrcObserver = null;
    }
  }
});

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