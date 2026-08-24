import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootRegistry, postJson, joinChannel, pollMessages, makeDb } from './helpers.js';
test('smoke: registry + helpers work', async () => {
    const reg = await bootRegistry();
    await joinChannel(reg.url, 'smoke', 'a1');
    const { status } = await postJson(reg.url, '/relay', {
        id: 'm1', type: 'event', from: 'a1', to: 'a1', payload: { hi: 1 }, channel: 'smoke', timestamp: Date.now(),
    });
    assert.equal(status, 200);
    const msgs = await pollMessages(reg.url, 'a1');
    assert.equal(msgs.length, 1);
    const db = makeDb();
    db.exec('CREATE TABLE t (x INTEGER)');
    await reg.close();
});
