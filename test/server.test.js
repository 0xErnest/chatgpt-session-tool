'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, upstreamError } = require('../server.js');

test('summarize: 解析 accounts/check 响应并去重 default 键', () => {
  const check = {
    accounts: {
      default: { account: { account_id: 'acc-1' }, entitlement: { has_active_subscription: true } },
      'acc-1': { account: { account_id: 'acc-1' }, entitlement: { has_active_subscription: true } },
      'acc-2': {
        account: { account_id: 'acc-2', plan_type: 'chatgptplusplan' },
        entitlement: { subscription_plan: 'chatgptproplan', expires_at: '2027-01-01' },
        last_active_subscription: { will_renew: false, purchase_origin_platform: 'chatgpt_mobile_ios' },
      },
    },
  };
  const list = summarize(check);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    account_id: 'acc-1', name: null, plan_type: 'unknown', is_active: true,
    expires_at: null, will_renew: null, origin: null, is_deactivated: null,
  });
  assert.equal(list[1].plan_type, 'chatgptplusplan');
  assert.equal(list[1].expires_at, '2027-01-01');
  assert.equal(list[1].will_renew, false);
  assert.equal(list[1].origin, 'chatgpt_mobile_ios');
});

test('summarize: 空响应 / 缺字段不炸', () => {
  assert.deepEqual(summarize({}), []);
  assert.deepEqual(summarize(null), []);
  assert.deepEqual(summarize({ accounts: { x: null } }), [
    { account_id: 'x', name: null, plan_type: 'unknown', is_active: null,
      expires_at: null, will_renew: null, origin: null, is_deactivated: null },
  ]);
});

test('upstreamError: 401/403 给提示，网络错误(status 0)单独说明', () => {
  assert.equal(upstreamError({ status: 401, text: '' }).hint.includes('过期'), true);
  assert.equal(upstreamError({ status: 403, text: '' }).hint.includes('Cloudflare'), true);
  assert.equal(upstreamError({ status: 0, text: 'upstream timeout' }).hint.includes('网络'), true);
  assert.equal(upstreamError({ status: 0, text: 'upstream timeout' }).raw, 'upstream timeout');
});