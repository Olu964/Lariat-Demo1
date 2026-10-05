/* Lariat Texas-law helpbot — frontend widget.
 * Markup + animation from the uploaded chatbot-animation widget
 * (launcher ring, robot icon morph, typing dots), named Kevin and
 * connected to the real backend: POST /api/chat/ask (same-origin, or
 * window.LARIAT_API_BASE). The demo's local fake reply is replaced by live
 * answers grounded in local bill data + OpenStates + AI. No external CDN,
 * so the strict CSP (script-src 'self') is unaffected.
 */
(() => {
  if (document.querySelector('.chatbot')) return;

  const apiBase = typeof window.LARIAT_API_BASE === 'string'
    ? window.LARIAT_API_BASE.trim().replace(/\/+$/, '')
    : '';

  const host = document.createElement('section');
  host.className = 'chatbot';
  host.setAttribute('aria-label', 'Chat support');
  host.innerHTML = `
    <div class="chat-window" aria-hidden="true">
      <header class="chat-header">
        <div class="agent-avatar" aria-hidden="true"><svg viewBox="0 0 48 48" role="img" aria-label="Kevin assistant"><path d="M24 5v5m0 0h4" /><rect x="13" y="12" width="22" height="20" rx="10" /><circle cx="20" cy="21" r="1.7" /><circle cx="28" cy="21" r="1.7" /><path d="M20 26.5c2.5 2 5.5 2 8 0" /><rect x="19" y="34.5" width="10" height="4" rx="2" /><path d="M7 36.5h4M37 36.5h4" /></svg></div>
        <div>
          <strong>Kevin</strong>
          <span><i></i>Please be patient, may take some time</span>
        </div>
        <button class="icon-button" type="button" aria-label="Close chat">×</button>
      </header>
      <div class="messages" aria-live="polite"></div>
      <form class="chat-form">
        <label class="sr-only" for="lariat-chat-input">Type your message</label>
        <input id="lariat-chat-input" autocomplete="off" maxlength="500" placeholder="Ask about bills or this site...">
        <button type="submit" aria-label="Send message">➤</button>
      </form>
      <div class="chat-disclaimer">Answers start from official Texas records + OpenStates. Verify with official sources. Not legal advice.</div>
    </div>
    <button class="chat-launcher" type="button" aria-label="Open chat" aria-expanded="false">
      <span class="launcher-ring"></span>
      <span class="launcher-icon launcher-icon-chat" aria-hidden="true">
        <svg class="robot-image" viewBox="0 0 48 48" role="img" aria-label="Robot assistant">
          <path class="robot-antenna" d="M24 8V4m0 0h4" />
          <rect class="robot-head" x="9" y="10" width="30" height="24" rx="9" />
          <path class="robot-face" d="M16 21h.01M32 21h.01M18 27c3 2.5 9 2.5 12 0" />
          <path class="robot-body" d="M14 34h20l4 8H10l4-8Z" />
          <path class="robot-detail" d="M20 38h8M8 37H5m38 0h-3" />
        </svg>
      </span>
      <span class="launcher-icon launcher-icon-close" aria-hidden="true">×</span>
      <span class="notification-dot" aria-hidden="true">1</span>
    </button>
    <button class="chatbot-name" type="button">Kevin</button>`;
  document.body.append(host);

  const chatWindow = host.querySelector('.chat-window');
  const launcher = host.querySelector('.chat-launcher');
  const nameLabel = host.querySelector('.chatbot-name');
  const closeBtn = host.querySelector('.icon-button');
  const form = host.querySelector('.chat-form');
  const input = host.querySelector('#lariat-chat-input');
  const messages = host.querySelector('.messages');
  let greeted = false;
  // Memory for follow-ups like "why does this bill impact high schoolers".
  // The backends (server/server.js, api/chat/ask.js) reuse these bills
  // instead of keyword-guessing a new one.
  let lastIds = [];
  let lastQA = [];

  function setOpen(open) {
    host.classList.toggle('is-open', open);
    chatWindow.classList.toggle('is-open', open);
    chatWindow.setAttribute('aria-hidden', String(!open));
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      host.classList.add('seen');
      if (!greeted) {
        greeted = true;
        addMessage('Hi! I’m Kevin. Ask me about Texas bills or anything on this site — the feed, alerts, pricing, privacy, key dates, or finding your legislator.', 'agent');
      }
      setTimeout(() => input.focus(), 220);
    }
  }

  launcher.addEventListener('click', () => setOpen(!host.classList.contains('is-open')));
  nameLabel.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host.classList.contains('is-open')) setOpen(false);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || text.length < 3) return;
    addMessage(text, 'user');
    input.value = '';
    const typing = document.createElement('div');
    typing.className = 'message message-agent typing';
    typing.setAttribute('aria-hidden', 'true');
    typing.innerHTML = '<span></span><span></span><span></span>';
    messages.append(typing);
    messages.scrollTop = messages.scrollHeight;
    try {
      const res = await fetch(`${apiBase}/api/chat/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, contextIds: lastIds, history: lastQA.slice(-2) }),
      });
      const data = await res.json().catch(() => ({}));
      typing.remove();
      if (!res.ok || !data.ok) {
        addMessage(data.error || 'Sorry — I could not answer that right now. Try the bill feed instead.', 'agent');
        return;
      }
      lastIds = Array.isArray(data.citations) ? data.citations.map((c) => c.identifier).filter(Boolean).slice(0, 3) : lastIds;
      lastQA.push({ q: text, a: String(data.answer || '').slice(0, 500) });
      if (lastQA.length > 4) lastQA = lastQA.slice(-4);
      addMessage(data.answer, 'agent', data.citations);
    } catch (error) {
      typing.remove();
      addMessage('Network error — please check your connection and try again.', 'agent');
    }
  });

  // Minimal safe formatter: the AI sometimes returns markdown (**bold**,
  // "- " bullets, [links](url)) despite the plain-text instruction. This
  // renders that subset by building DOM nodes — never innerHTML — so
  // untrusted bill text stays inert (SECURITY.md).
  function appendInline(el, text) {
    const token = /(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|^([-•]|\d+[.)])\s+|\n([-•]|\d+[.)])\s+| - (?=\*\*)|^((?:Who|How|Why|Status|Bottom line):)|\n((?:Who|How|Why|Status|Bottom line):))/g;
    let last = 0;
    let m;
    const pushText = (s) => { if (s) el.append(s); };
    while ((m = token.exec(text))) {
      pushText(text.slice(last, m.index));
      const t = m[0];
      const label = t.match(/(Who|How|Why|Status|Bottom line):$/);
      if (label) {
        if (t.startsWith('\n')) el.append(document.createElement('br'));
        const strong = document.createElement('strong');
        strong.textContent = label[0];
        el.append(strong);
      } else if (t.startsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = t.slice(2, -2);
        el.append(strong);
      } else if (t.startsWith('[')) {
        const parts = t.match(/^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/);
        const link = document.createElement('a');
        if (parts) {
          try {
            link.href = new URL(parts[2]).href;
          } catch (error) { pushText(t); last = token.lastIndex; continue; }
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = parts[1];
          el.append(link);
        } else {
          pushText(t);
        }
      } else {
        // List separator ("- " or "1. " at a line start): break the line.
        // Keep the number for numbered items, use a bullet otherwise.
        el.append(document.createElement('br'));
        const numbered = t.match(/\d+[.)]/);
        const bullet = document.createElement('span');
        bullet.setAttribute('aria-hidden', 'true');
        bullet.textContent = numbered ? `${numbered[0]} ` : '• ';
        el.append(bullet);
      }
      last = token.lastIndex;
    }
    pushText(text.slice(last));
  }

  // Split long bot answers into chat-sized bubbles (~550 chars) at
  // paragraph, then sentence, boundaries — never mid-word. Short answers
  // stay a single bubble.
  const BUBBLE_LIMIT = 550;

  function splitBubbles(text) {
    const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = '';
    const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
    const pushPara = (para) => {
      if (para.length <= BUBBLE_LIMIT && (cur + '\n\n' + para).trim().length <= BUBBLE_LIMIT) {
        cur = cur ? `${cur}\n\n${para}` : para;
        return;
      }
      if (cur) flush();
      if (para.length <= BUBBLE_LIMIT) { cur = para; return; }
      // One oversized paragraph: split into sentences.
      const sentences = para.match(/[^.!?]+[.!?]+["']?\s*|[^.!?]+$/g) || [para];
      for (const s of sentences) {
        const piece = s.trim();
        if (!piece) continue;
        if ((cur + ' ' + piece).trim().length <= BUBBLE_LIMIT) {
          cur = cur ? `${cur} ${piece}` : piece;
        } else {
          flush();
          // A single pathological sentence: hard-cut at a word boundary.
          if (piece.length <= BUBBLE_LIMIT) { cur = piece; continue; }
          let rest = piece;
          while (rest.length > BUBBLE_LIMIT) {
            const cut = rest.lastIndexOf(' ', BUBBLE_LIMIT);
            const at = cut > BUBBLE_LIMIT * 0.5 ? cut : BUBBLE_LIMIT;
            chunks.push(rest.slice(0, at).trimEnd());
            rest = rest.slice(at).trimStart();
          }
          cur = rest;
        }
      }
    };
    paras.forEach(pushPara);
    flush();
    return chunks.length ? chunks : [String(text)];
  }

  function fillBubble(message, chunk) {
    // Paragraphs first (blank-line separated), then inline formatting.
    chunk.split(/\n\s*\n/).forEach((para, i) => {
      if (i > 0) message.append(document.createElement('br'), document.createElement('br'));
      appendInline(message, para.trim());
    });
  }

  function addMessage(text, kind, citations) {
    const parts = kind === 'agent' ? splitBubbles(text) : [String(text)];
    let lastBubble = null;
    parts.forEach((part) => {
      const message = document.createElement('div');
      message.className = `message message-${kind}`;
      if (kind === 'agent') fillBubble(message, part);
      else message.textContent = part; // user text: plain, unformatted
      messages.append(message);
      lastBubble = message;
    });
    const message = lastBubble;
    if (kind === 'agent' && Array.isArray(citations) && citations.length) {
      citations.slice(0, 3).forEach((c) => {
        if (!c || !c.identifier || !/^https?:\/\//i.test(c.sourceUrl || '')) return;
        const cite = document.createElement('span');
        cite.className = 'lariat-cite';
        const link = document.createElement('a');
        try {
          link.href = new URL(c.sourceUrl).href;
        } catch (error) { return; }
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `${c.identifier}: ${c.title || 'Texas bill'}`;
        cite.append(' • ', link);
        message.append(cite);
      });
    }
    messages.scrollTop = messages.scrollHeight;
  }
})();
