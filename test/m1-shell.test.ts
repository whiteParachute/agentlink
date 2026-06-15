import test from 'node:test';
import assert from 'node:assert/strict';
import { renderM1ShellHtml } from '../src/web/m1-shell.js';

void test('M1 shell HTML exposes fake input only controls and future placeholders', () => {
  const html = renderM1ShellHtml();
  assert.match(html, /AL-M1-UI-001/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /\/api\/v1\/fake-im\/events/);
  for (const field of [
    'kind',
    'message_id',
    'chat_id',
    'thread_id',
    'reply_to_message_id',
    'text',
    'agent_mentioned',
    'speaker_channel_user_id',
    'group_profile_id',
    'metadata',
  ]) {
    assert.match(html, new RegExp(field));
  }
  assert.match(html, /DM sample/);
  assert.match(html, /Group sample/);
  assert.match(html, /Thread reply sample/);
  assert.match(html, /fake input only/i);
  assert.match(html, /Session: disabled \/ future slice placeholder/);
  assert.match(html, /Memory: disabled \/ future slice placeholder/);
  assert.match(html, /Main Agent: disabled \/ future slice placeholder/);
});

void test('M1 shell stores token only in sessionStorage and has no hardcoded real token', () => {
  const html = renderM1ShellHtml();
  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.doesNotMatch(html, /AGENTLINK_INGRESS_BEARER_TOKEN\s*=/);
  assert.doesNotMatch(html, /Bearer\s+(fake-im-token|ingress-test-token|test-token|secret|prod-secret)/i);
  assert.doesNotMatch(html, /Authorization:\s*Bearer\s+[A-Za-z0-9._:-]+/i);
});
