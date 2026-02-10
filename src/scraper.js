/**
 * WhatsApp Web DOM Scraper — Updated for current WhatsApp Web (2026)
 *
 * Uses page.exposeFunction() bridge instead of fetch() to bypass
 * WhatsApp Web's Content Security Policy.
 */

/**
 * Returns JavaScript code to be injected into the WhatsApp Web page.
 * Expects window.__watools_saveMessages(chatName, messagesJSON) to be
 * exposed by Puppeteer before injection.
 */
export function getInjectionScript() {
  // NOTE: This string is passed to new Function() and executed in the browser.
  // Regex escaping: one backslash in the final regex = one backslash here
  // (no double-escaping needed since this is a template literal, not a string in a string).
  return `
    (function() {
      if (window.__watools_injected) {
        console.log('[WATools] Already injected, skipping');
        return;
      }
      window.__watools_injected = true;

      const SEEN_MESSAGES = new Set();
      let currentChatName = '';
      let observer = null;
      let chatObserver = null;

      function log(msg) {
        console.log('[WATools]', msg);
      }

      log('Script injected successfully');

      // ─── Extract chat name from header ───
      function getChatName() {
        var el = document.querySelector('#main header span[dir="auto"]');
        if (el && el.textContent.trim()) {
          return el.textContent.trim();
        }
        var el2 = document.querySelector('#main header span[title]');
        if (el2) return el2.getAttribute('title').trim();
        return null;
      }

      // ─── Extract messages from DOM ───
      async function extractMessages() {
        var messages = [];
        var chatName = getChatName();
        if (!chatName) return messages;

        var msgElements = document.querySelectorAll('.message-in, .message-out');
        var promises = [];

        for (var i = 0; i < msgElements.length; i++) {
          promises.push(extractSingleMessage(msgElements[i], chatName));
        }

        var results = await Promise.all(promises);
        
        for (var j = 0; j < results.length; j++) {
            var msg = results[j];
            if (msg && (msg.content || msg.mediaUrl)) {
                // Use WhatsApp ID for deduplication if available
                var msgKey = msg.id || (chatName + '|' + msg.sender + '|' + (msg.content ? msg.content.substring(0, 50) : 'media') + '|' + msg.timestamp);
                
                if (!SEEN_MESSAGES.has(msgKey)) {
                    SEEN_MESSAGES.add(msgKey);
                    messages.push(msg);
                }
            }
        }

        return messages;
      }

      // ─── Convert Blob URL to Base64 ───
      async function blobToBase64(url) {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result); // "data:image/jpeg;base64,..."
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            return null;
        }
      }

      // ─── Extract a single message ───
      async function extractSingleMessage(el, chatName) {
        var isOutgoing = el.classList.contains('message-out');
        
        // ─── WhatsApp ID ───
        // Attempt to find data-id on parent or self
        var idEl = el.closest('[data-id]');
        var id = idEl ? idEl.getAttribute('data-id') : null;
        
        // Fallback: generate mostly-unique ID if missing (shouldn't happen on standard msgs)
        if (!id) {
             // ... logic ... but usually data-id is present on row.
             // If missing, we might skip or fallback to content hash.
             // Let's fallback to null and let DB auto-inc? No, we need unique for dedup.
             // We'll leave it null and let the loop handle it?
             // Actually, let's use the old method for fallback key in the set, but send 'id' to server.
        }

        // ─── Sender ───
        var sender = 'You';
        if (!isOutgoing) {
          var senderEl = el.querySelector('span._ahxy[dir="auto"]');
          if (senderEl) {
            sender = senderEl.textContent.trim();
          } else {
            // Try from data-pre-plain-text
            var prePlainSender = el.querySelector('.copyable-text[data-pre-plain-text]');
            if (prePlainSender) {
              var preText = prePlainSender.getAttribute('data-pre-plain-text');
              var senderMatch = preText.match(/\]\s*(.+?):\s*$/);
              if (senderMatch) sender = senderMatch[1].trim();
            } else {
              sender = chatName;
            }
          }
        }

        // ─── Text content ───
        var content = '';
        var selectableTexts = el.querySelectorAll('span[data-testid="selectable-text"]');
        for (var i = 0; i < selectableTexts.length; i++) {
            var st = selectableTexts[i];
            if (st.classList.contains('quoted-mention')) continue;
            var textContent = st.textContent.trim();
            if (textContent) content = textContent;
        }

        // Fallback: copyable-text
        if (!content) {
            var prePlainFallback = el.querySelector('.copyable-text[data-pre-plain-text]');
            if (prePlainFallback) {
                var spans = prePlainFallback.querySelectorAll(':scope > span');
                for (var j = 0; j < spans.length; j++) {
                    var t = spans[j].textContent.trim();
                    if (t) { content = t; break; }
                }
            }
        }

        // ─── Media detection ───
        var type = 'text';
        var mediaUrl = '';
        var mediaData = null;

        var imgThumb = el.querySelector('[data-testid="image-thumb"]');
        var blobImg = el.querySelector('img[src*="blob"]');
        
        if (imgThumb || blobImg) {
            type = 'image';
            var imgEl = imgThumb ? imgThumb.querySelector('img') : blobImg;
            if (imgEl && imgEl.src) {
                mediaUrl = imgEl.src;
                // Convert blob to base64
                if (mediaUrl.startsWith('blob:')) {
                    mediaData = await blobToBase64(mediaUrl);
                }
            }
            if (!content) content = '[Image]';
        }
        
        if (type === 'text' && (el.querySelector('[data-testid="audio-play"]') || el.querySelector('audio'))) {
            type = 'audio';
            if (!content) content = '[Audio]';
        }
        if (type === 'text') {
            var videoThumb = el.querySelector('[data-testid="video-thumb"]');
            if (videoThumb || el.querySelector('video')) {
                type = 'video';
                if (!content) content = '[Video]';
            }
        }
        if (type === 'text' && el.querySelector('[data-testid="document-thumb"]')) {
            type = 'document';
            if (!content) content = '[Document]';
        }
        if (type === 'text' && el.querySelector('[data-testid="sticker"]')) {
            type = 'sticker';
            if (!content) content = '[Sticker]';
            // Stickers are also images often
            var stickerImg = el.querySelector('img[src*="blob"]');
            if (stickerImg) {
                 mediaUrl = stickerImg.src;
                 mediaData = await blobToBase64(mediaUrl);
            }
        }

        // ─── Timestamp ───
        var timestamp = '';
        var prePlainTs = el.querySelector('.copyable-text[data-pre-plain-text]');
        if (prePlainTs) {
            var preTs = prePlainTs.getAttribute('data-pre-plain-text');
            var tsMatch = preTs.match(/\[(.+?)\]/);
            if (tsMatch) {
                var rawTs = tsMatch[1];
                // Try to parse "HH:MM, M/D/YYYY" or "H:MM AM/PM, M/D/YYYY"
                var dateTimeMatch = rawTs.match(/^(\d{1,2}[:.\s]\d{2}(?:\s*[APap][Mm])?)(?:,\s*|\s+)(\d{1,2}\/\d{1,2}\/\d{2,4})$/);
                if (dateTimeMatch) {
                    var timePart = dateTimeMatch[1];
                    var datePart = dateTimeMatch[2];
                    var dateParts = datePart.split('/');
                    // Could be M/D/YYYY or D/M/YYYY depending on locale
                    var month = dateParts[0];
                    var day = dateParts[1];
                    var year = dateParts[2];
                    if (year.length === 2) year = '20' + year;
                    // Parse time (handle 12h or 24h)
                    var hours = 0, mins = 0;
                    var ampmMatch = timePart.match(/(\d{1,2})[:.](\d{2})\s*([APap][Mm])/);
                    if (ampmMatch) {
                        hours = parseInt(ampmMatch[1]);
                        mins = parseInt(ampmMatch[2]);
                        if (/[Pp]/.test(ampmMatch[3]) && hours !== 12) hours += 12;
                        if (/[Aa]/.test(ampmMatch[3]) && hours === 12) hours = 0;
                    } else {
                        var h24Match = timePart.match(/(\d{1,2})[:.](\d{2})/);
                        if (h24Match) {
                            hours = parseInt(h24Match[1]);
                            mins = parseInt(h24Match[2]);
                        }
                    }
                    // Build ISO: YYYY-MM-DDTHH:MM:00
                    timestamp = year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0') + 'T' + String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0') + ':00';
                } else {
                    timestamp = rawTs;
                }
            }
        }
        if (!timestamp) {
            // Fallback: extract time-only and use today's date
            var allSpans = el.querySelectorAll('span');
            for (var k = allSpans.length - 1; k >= 0; k--) {
                var spanText = allSpans[k].textContent.trim();
                if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(spanText)) {
                    var now = new Date();
                    var fallbackMatch = spanText.match(/(\d{1,2}):(\d{2})\s*([APap][Mm])?/);
                    if (fallbackMatch) {
                        var fh = parseInt(fallbackMatch[1]);
                        var fm = parseInt(fallbackMatch[2]);
                        if (fallbackMatch[3] && /[Pp]/.test(fallbackMatch[3]) && fh !== 12) fh += 12;
                        if (fallbackMatch[3] && /[Aa]/.test(fallbackMatch[3]) && fh === 12) fh = 0;
                        timestamp = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + 'T' + String(fh).padStart(2,'0') + ':' + String(fm).padStart(2,'0') + ':00';
                    }
                    break;
                }
            }
        }

        return { id: id, chatName: chatName, sender: sender, content: content, timestamp: timestamp, type: type, isOutgoing: isOutgoing, mediaUrl: mediaUrl, mediaData: mediaData };
      }

      // ─── Save messages via Puppeteer bridge ───
      function saveMessages(messages) {
        if (messages.length === 0) return;
        if (typeof window.__watools_saveMessages !== 'function') {
          log('Bridge function not available yet, retrying...');
          return;
        }
        // Send small batches if messages have heavy base64 data to avoid timeouts
        try {
          var chatName = messages[0].chatName;
          window.__watools_saveMessages(chatName, JSON.stringify(messages)).then(function(result) {
            var parsed = JSON.parse(result);
            if (parsed.inserted > 0) {
              log('Saved ' + parsed.inserted + ' new message(s) from "' + chatName + '"');
            }
            if (parsed.error) log('Error: ' + parsed.error);
          }).catch(function(err) {
            log('Save failed: ' + err.message);
          });
        } catch (err) {
          log('Failed to save: ' + err.message);
        }
      }

      // ─── Scrape and save ───
      async function scrapeAndSend() {
        var messages = await extractMessages();
        if (messages.length > 0) {
          log('Found ' + messages.length + ' new messages');
          saveMessages(messages);
        }
      }

      // ─── MutationObserver ───
      function setupObserver() {
        if (observer) observer.disconnect();

        var mainEl = document.querySelector('#main');
        if (!mainEl) {
          setTimeout(setupObserver, 2000);
          return;
        }

        var target = mainEl.querySelector('[role="application"]') || mainEl;

        observer = new MutationObserver(function() {
          clearTimeout(window.__watools_debounce);
          window.__watools_debounce = setTimeout(scrapeAndSend, 300);
        });

        observer.observe(target, { childList: true, subtree: true });
        log('Observing messages in real-time');

        // Also watch for scroll (loading old messages by scrolling up)
        var scrollPanel = mainEl.querySelector('[role="application"]') || mainEl;
        scrollPanel.addEventListener('scroll', function() {
          clearTimeout(window.__watools_scroll_debounce);
          window.__watools_scroll_debounce = setTimeout(scrapeAndSend, 500);
        }, true);
        log('Watching for scroll (old message loading)');

        // Periodic scrape every 3s to catch anything missed by observers
        if (window.__watools_periodic) clearInterval(window.__watools_periodic);
        window.__watools_periodic = setInterval(scrapeAndSend, 3000);

        setTimeout(scrapeAndSend, 500);
      }

      // ─── Watch for chat switches ───
      function watchChatChanges() {
        if (chatObserver) chatObserver.disconnect();
        var appContainer = document.querySelector('#app') || document.body;
        chatObserver = new MutationObserver(function() {
          var newChatName = getChatName();
          if (newChatName && newChatName !== currentChatName) {
            currentChatName = newChatName;
            log('Switched to chat: ' + currentChatName);
            SEEN_MESSAGES.clear();
            setTimeout(setupObserver, 1000);
          }
        });
        chatObserver.observe(appContainer, { childList: true, subtree: true });
      }

      window.__watools = {
        scrapeAndSend: scrapeAndSend,
        extractMessages: extractMessages,
        getChatName: getChatName,
        getSeenCount: function() { return SEEN_MESSAGES.size; },
        clearSeen: function() { SEEN_MESSAGES.clear(); },
        forceSync: async function(targetChatName) {
            const actualChatName = getChatName();
            if (targetChatName && actualChatName !== targetChatName) {
                return { 
                    success: false, 
                    error: 'Chat mismatch', 
                    expected: targetChatName, 
                    actual: actualChatName 
                };
            }
            
            log('Force sync triggered for: ' + (actualChatName || 'current chat'));
            SEEN_MESSAGES.clear(); // Clear cache to re-evaluate all DOM messages
            await scrapeAndSend();
            return { success: true, count: SEEN_MESSAGES.size, chatName: actualChatName };
        }
      };

      currentChatName = getChatName() || '';
      log('Current chat: ' + (currentChatName || '(none)'));
      setupObserver();
      watchChatChanges();

      setInterval(function() {
        var chatName = getChatName();
        if (chatName && chatName !== currentChatName) {
          currentChatName = chatName;
          SEEN_MESSAGES.clear();
        }
        scrapeAndSend();
      }, 10000);

      log('WATools ready! Messages will be logged automatically.');
    })();
  `;
}
