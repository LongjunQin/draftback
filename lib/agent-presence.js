'use strict';

/*
 * 智能体在不在听、有没有领取(电脑版规划 v3 第 4.1 节规则②)。
 *
 * 两件事分开记:
 *   1. 监听登记:`mdreview wait` 启动时登记、每 30 秒续期、90 秒没续期自动失效;只说明"有程序在监听",不是接手。
 *      wait 因用户交出批注而退出时转为「已交棒」(handoff):智能体正在读批注、准备 begin-apply,这段时间仍算在线,
 *      默认给 15 分钟;超时没领取就回到"没人在听"。程序被强退不会留下假在线(靠失效时间)。
 *   2. 领取:记在审阅会话上(claimedAt / claimedBy,见 review-store.claimReview),以真实事件为准——
 *      `mdreview claim` 或 `mdreview begin-apply` 成功。界面只在领取后才显示"AI 正在修改"。
 *
 * 登记存在数据目录的 listeners.json({ [reviewId]: { agent, since, lastSeen, handoffUntil } }),
 * CLI 与本地服务都直接读写这个文件,服务不在也能登记。
 */

const path = require('path');
const store = require('./review-store');

const LISTEN_TTL_MS = 90 * 1000;        // 超过这么久没续期就算掉线
const HEARTBEAT_MS = 30 * 1000;         // wait 的续期间隔
const HANDOFF_MS = 15 * 60 * 1000;      // 交棒后给智能体领取的时间

function listenersFile(options = {}) {
  return path.join(store.getDataDir(options), 'listeners.json');
}

function readAll(options = {}) {
  const data = store.readJsonStrict(listenersFile(options), {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function entryAlive(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  const lastSeen = Date.parse(entry.lastSeen || 0);
  if (Number.isFinite(lastSeen) && now - lastSeen <= LISTEN_TTL_MS) return true;
  const handoffUntil = Date.parse(entry.handoffUntil || 0);
  return Number.isFinite(handoffUntil) && handoffUntil > now;
}

function cleanAgentName(value) {
  const name = String(value || '').trim().slice(0, 80);
  return name || 'AI';
}

async function mutate(options, mutator) {
  return store.mutateJson(listenersFile(options), {}, (data) => {
    const now = Date.now();
    for (const [id, entry] of Object.entries(data)) {
      if (!entryAlive(entry, now)) delete data[id]; // 顺手清掉早已掉线的登记
    }
    return mutator(data, now);
  }, options);
}

/** wait 启动或续期:登记为"在听"。同一智能体续期时保留 since;换了智能体就从现在算。 */
async function register(reviewId, input = {}, options = {}) {
  if (!reviewId) throw new store.ReviewStoreError('BAD_ARGUMENT', '缺少 reviewId。', { httpStatus: 400 });
  const agent = cleanAgentName(input.agent);
  return mutate(options, (data, now) => {
    const nowIso = new Date(now).toISOString();
    const prior = data[reviewId];
    const since = prior && prior.agent === agent && entryAlive(prior, now) ? prior.since : nowIso;
    data[reviewId] = { agent, since, lastSeen: nowIso, handoffUntil: null };
    return { ...data[reviewId] };
  });
}

/** wait 因用户交出而退出:转为"已交棒",给智能体读批注、begin-apply 的时间。 */
async function handoff(reviewId, input = {}, options = {}) {
  if (!reviewId) throw new store.ReviewStoreError('BAD_ARGUMENT', '缺少 reviewId。', { httpStatus: 400 });
  const agent = cleanAgentName(input.agent);
  const minutes = Number(input.minutes);
  const span = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : HANDOFF_MS;
  return mutate(options, (data, now) => {
    const nowIso = new Date(now).toISOString();
    const prior = data[reviewId];
    data[reviewId] = {
      agent,
      since: prior && prior.agent === agent ? prior.since : nowIso,
      lastSeen: nowIso,
      handoffUntil: new Date(now + span).toISOString(),
    };
    return { ...data[reviewId] };
  });
}

/** wait 正常结束(定稿、手工改完、取消、超时):注销。 */
async function unregister(reviewId, options = {}) {
  if (!reviewId) return false;
  return mutate(options, (data) => {
    const existed = Boolean(data[reviewId]);
    delete data[reviewId];
    return existed;
  });
}

/** 某个会话现在有没有人在听(读文件,不写)。 */
function describe(reviewId, options = {}, now = Date.now()) {
  let entry = null;
  try { entry = readAll(options)[reviewId] || null; } catch { entry = null; }
  if (!entry || !entryAlive(entry, now)) return { listening: false };
  const lastSeen = Date.parse(entry.lastSeen || 0);
  const handoffUntil = Date.parse(entry.handoffUntil || 0);
  const handoff = Number.isFinite(handoffUntil) && handoffUntil > now; // 交棒中:wait 已返回,智能体在读批注
  return {
    listening: true,
    agent: entry.agent,
    since: entry.since,
    lastSeen: entry.lastSeen,
    handoff,
    expiresAt: new Date(handoff ? handoffUntil : lastSeen + LISTEN_TTL_MS).toISOString(),
  };
}

/**
 * 界面与手机要显示的三档(规则①的"已交出"三种):
 *   none      已交出,没人在听
 *   listening 已交出,有程序在听,还没领取
 *   claimed   AI 已领取 / 正在修改
 * 其他状态下返回 null(不适用)。
 */
function agentStateFor(review, presence) {
  if (!review) return null;
  if (review.status === 'applying') return review.applyMode === 'manual' ? null : 'claimed';
  if (review.status !== 'ready_to_apply') return null;
  if (review.claimedAt) return 'claimed';
  return presence && presence.listening ? 'listening' : 'none';
}

/** 给会话记录补上在线状态与三档;server 的摘要、bundle、列表都用它,保证各处口径一致。 */
function withAgentState(review, options = {}, now = Date.now()) {
  if (!review || typeof review !== 'object') return review;
  const presence = describe(review.id, options, now);
  return {
    ...review,
    agent: presence,
    agentState: agentStateFor(review, presence),
    cliScript: path.join(__dirname, '..', 'mdreview.js'),
  };
}

module.exports = {
  LISTEN_TTL_MS,
  HEARTBEAT_MS,
  HANDOFF_MS,
  listenersFile,
  register,
  heartbeat: register,
  handoff,
  unregister,
  describe,
  agentStateFor,
  withAgentState,
  cleanAgentName,
};
