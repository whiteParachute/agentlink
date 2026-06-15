export function renderM1ShellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agentlink AL-M1-UI-001 Web Shell</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f172a; --panel: #111827; --text: #e5e7eb; --muted: #94a3b8; --line: #334155; --accent: #38bdf8; --danger: #f87171; --ok: #34d399; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { color: var(--muted); line-height: 1.55; }
    .grid { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: 20px; align-items: start; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; box-shadow: 0 16px 48px rgba(0, 0, 0, .22); }
    label { display: block; font-weight: 650; margin: 12px 0 6px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--line); border-radius: 10px; background: #020617; color: var(--text); padding: 10px 12px; }
    textarea { min-height: 86px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .samples { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    button { border: 0; border-radius: 999px; padding: 10px 14px; cursor: pointer; color: #08111f; background: var(--accent); font-weight: 700; }
    button.secondary { background: #cbd5e1; }
    button.submit { margin-top: 16px; width: 100%; }
    .placeholder { border: 1px dashed var(--line); border-radius: 10px; padding: 10px 12px; color: var(--muted); margin-top: 8px; }
    .status { color: var(--muted); margin: 0 0 10px; }
    .status.ok { color: var(--ok); }
    .status.err { color: var(--danger); }
    pre { white-space: pre-wrap; overflow: auto; background: #020617; border: 1px solid var(--line); border-radius: 10px; padding: 12px; min-height: 360px; }
    .hint { font-size: 13px; color: var(--muted); }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Agentlink AL-M1-UI-001 Web Shell</h1>
      <p>Devbox-hosted M1 frontend shell for fake input only. It calls <code>POST /api/v1/fake-im/events</code> and displays the resulting SourceEvent / Entry JSON.</p>
    </header>
    <section class="grid">
      <form id="fake-im-form" class="card">
        <h2>Fake IM event</h2>
        <label for="token">Ingress bearer token</label>
        <input id="token" name="token" type="password" autocomplete="off" placeholder="Paste token for this browser session">
        <p class="hint">Token is kept in sessionStorage only and is sent as a Bearer token to the same-origin fake IM endpoint.</p>

        <div class="samples" aria-label="sample events">
          <button type="button" class="secondary" data-sample="dm">DM sample</button>
          <button type="button" class="secondary" data-sample="group">Group sample</button>
          <button type="button" class="secondary" data-sample="thread">Thread reply sample</button>
        </div>

        <div class="row">
          <div>
            <label for="kind">kind</label>
            <select id="kind" name="kind">
              <option value="dm">dm</option>
              <option value="group">group</option>
              <option value="thread">thread</option>
            </select>
          </div>
          <div>
            <label for="message_id">message_id</label>
            <input id="message_id" name="message_id" placeholder="msg_001" required>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="chat_id">chat_id</label>
            <input id="chat_id" name="chat_id" placeholder="required for group/thread">
          </div>
          <div>
            <label for="thread_id">thread_id</label>
            <input id="thread_id" name="thread_id" placeholder="required for thread">
          </div>
        </div>

        <label for="reply_to_message_id">reply_to_message_id</label>
        <input id="reply_to_message_id" name="reply_to_message_id" placeholder="parent message for reply">

        <label for="text">text</label>
        <textarea id="text" name="text" placeholder="fake message text"></textarea>

        <label><input id="agent_mentioned" name="agent_mentioned" type="checkbox" style="width:auto"> agent_mentioned</label>

        <div class="row">
          <div>
            <label for="speaker_channel_user_id">speaker_channel_user_id</label>
            <input id="speaker_channel_user_id" name="speaker_channel_user_id" placeholder="optional existing ChannelUser id">
          </div>
          <div>
            <label for="group_profile_id">group_profile_id</label>
            <input id="group_profile_id" name="group_profile_id" placeholder="optional existing GroupProfile id">
          </div>
        </div>

        <label for="metadata">metadata JSON</label>
        <textarea id="metadata" name="metadata" spellcheck="false">{}</textarea>

        <button class="submit" type="submit">Send fake IM event</button>
      </form>

      <section class="card">
        <h2>Result</h2>
        <p id="status" class="status">Idle. Submit a fake input event to inspect HTTP status, created, fake_im_event, source_event, entry, or error JSON.</p>
        <pre id="result" aria-live="polite">{}</pre>
        <div class="placeholder">Session: disabled / future slice placeholder.</div>
        <div class="placeholder">Memory: disabled / future slice placeholder.</div>
        <div class="placeholder">Main Agent: disabled / future slice placeholder.</div>
      </section>
    </section>
  </main>
  <script>
    const endpoint = '/api/v1/fake-im/events';
    const tokenInput = document.querySelector('#token');
    const form = document.querySelector('#fake-im-form');
    const statusEl = document.querySelector('#status');
    const resultEl = document.querySelector('#result');
    const samples = {
      dm: { kind: 'dm', message_id: 'dm-msg-001', chat_id: '', thread_id: '', reply_to_message_id: '', text: 'hello from a fake dm', agent_mentioned: true, metadata: { sample: 'dm' } },
      group: { kind: 'group', message_id: 'group-msg-001', chat_id: 'fake-group-001', thread_id: '', reply_to_message_id: '', text: 'hello from a fake group', agent_mentioned: true, metadata: { sample: 'group' } },
      thread: { kind: 'thread', message_id: 'thread-msg-001', chat_id: 'fake-group-001', thread_id: 'thread-001', reply_to_message_id: 'group-msg-001', text: 'hello from a fake thread reply', agent_mentioned: false, metadata: { sample: 'thread-reply' } }
    };

    tokenInput.value = sessionStorage.getItem('agentlink.m1.ingressToken') || '';
    tokenInput.addEventListener('input', () => sessionStorage.setItem('agentlink.m1.ingressToken', tokenInput.value));

    document.querySelectorAll('[data-sample]').forEach((button) => {
      button.addEventListener('click', () => fillSample(button.dataset.sample));
    });

    function fillSample(name) {
      const sample = samples[name];
      if (!sample) return;
      for (const [key, value] of Object.entries(sample)) {
        const field = form.elements.namedItem(key);
        if (!field) continue;
        if (key === 'metadata') field.value = JSON.stringify(value, null, 2);
        else if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = String(value);
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      statusEl.className = 'status';
      const token = tokenInput.value.trim();
      let metadata;
      try {
        metadata = JSON.parse(form.elements.namedItem('metadata').value || '{}');
        if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') throw new Error('metadata must be a JSON object');
      } catch (error) {
        showError('metadata JSON parse failed', error);
        return;
      }
      const payload = compact({
        kind: valueOf('kind'),
        message_id: valueOf('message_id'),
        chat_id: valueOf('chat_id'),
        thread_id: valueOf('thread_id'),
        reply_to_message_id: valueOf('reply_to_message_id'),
        text: valueOf('text'),
        agent_mentioned: form.elements.namedItem('agent_mentioned').checked,
        speaker_channel_user_id: valueOf('speaker_channel_user_id'),
        group_profile_id: valueOf('group_profile_id'),
        metadata,
      });
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      try {
        const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
        const json = await response.json();
        statusEl.textContent = 'HTTP ' + response.status + ' / created=' + String(json.created ?? false);
        statusEl.className = response.ok ? 'status ok' : 'status err';
        resultEl.textContent = JSON.stringify(json, null, 2);
      } catch (error) {
        showError('request failed', error);
      }
    });

    function valueOf(name) { return form.elements.namedItem(name).value.trim(); }
    function compact(input) {
      return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== '' && value !== undefined));
    }
    function showError(message, error) {
      statusEl.textContent = message;
      statusEl.className = 'status err';
      resultEl.textContent = JSON.stringify({ error: message, detail: String(error && error.message ? error.message : error) }, null, 2);
    }
    fillSample('dm');
  </script>
</body>
</html>`;
}
