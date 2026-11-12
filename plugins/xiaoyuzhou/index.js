/**
 * 小宇宙播客插件（免登录版）。
 *
 * 小宇宙没有开放接口，App 用的接口不带登录令牌一律 401。这里只读小宇宙网页版的
 * 公开页面：节目页 / 单集页是服务端渲染的 Next.js 页面，整页数据放在
 * <script id="__NEXT_DATA__"> 里（RSSHub 的小宇宙路由也是这么读的）。
 *
 * 能做的：
 * - 按分享链接找节目：节目链接、单集链接、xyzfm.link 短链接、裸 24 位 id；
 * - 节目详情；节目页带的最新一批单集（目前 15 期：标题、时长、发布时间、简介、音频直链）；
 * - 粘贴过的单集链接会记下来，哪怕它早于最新那批，也出现在这个节目的列表里；
 * - 订阅存在插件自己的本地存储里，不碰小宇宙账号。
 * 做不到的：关键词搜索、完整的历史单集、小宇宙账号里的订阅和收听进度。
 * 付费单集（payType 不是 FREE，或 isPrivateMedia）没有公开音频：标付费，取流抛 forbidden。
 */

var axios = require('axios')

var PLATFORM = 'xiaoyuzhou'
var WEB = 'https://www.xiaoyuzhoufm.com'
var UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
var ID_RE = /^[0-9a-f]{24}$/
var LINK_RE = /(podcast|episode)\/([0-9a-f]{24})/
var SHORT_LINK_RE = /https?:\/\/xyzfm\.link\/[A-Za-z0-9/_-]+/
var SUBS_KEY = 'subscriptions'
var PINNED_PREFIX = 'pinned:'
/** 每个节目最多记这么多期「粘贴过链接的老单集」 */
var PINNED_MAX = 50
/** 详情和节目列表读的是同一页：一分钟内复用，打开一个节目只请求一次 */
var PAGE_TTL_MS = 60 * 1000
var EPISODE_DESC_MAX = 1000
var SNAPSHOT_DESC_MAX = 200

function pluginError(code, message) {
  if (typeof PluginError === 'function') return new PluginError(code, message)
  var err = new Error(message)
  err.name = 'PluginError'
  err.code = code
  return err
}

/** 出网错误 → 协议错误码（PROTOCOL §7） */
function toPluginError(err) {
  if (err && err.name === 'PluginError') return err
  var status = (err && err.response && err.response.status) || 0
  if (status === 404) return pluginError('not-found', '小宇宙上找不到这个节目或单集')
  if (status === 429) return pluginError('rate-limited', '小宇宙限流，请稍后再试')
  if (status >= 500) return pluginError('network', '小宇宙服务端错误（HTTP ' + status + '）')
  if (err && err.isAxiosError) {
    if (err.code === 'forbidden' || err.code === 'unauthorized' || err.code === 'rate-limited') {
      return pluginError(err.code, err.message)
    }
    return pluginError('network', err.message || '网络请求失败')
  }
  return err
}

/** 唯一的出网入口 */
function getText(url, extra) {
  var config = { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, responseType: 'text' }
  if (extra) Object.keys(extra).forEach(function (k) { config[k] = extra[k] })
  return axios.get(url, config).catch(function (err) { throw toPluginError(err) })
}

/** 页面里那块 __NEXT_DATA__ 的 pageProps */
function readPageProps(html) {
  var m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''))
  if (!m) throw pluginError('unknown', '小宇宙网页结构变了，读不到节目数据')
  var data
  try {
    data = JSON.parse(m[1])
  } catch (e) {
    throw pluginError('unknown', '小宇宙网页数据解析失败')
  }
  return (data && data.props && data.props.pageProps) || {}
}

var pageCache = {}

async function fetchPodcastPage(pid) {
  pid = String(pid || '')
  if (!ID_RE.test(pid)) throw pluginError('not-found', '不是有效的小宇宙节目')
  var hit = pageCache[pid]
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.podcast
  var res = await getText(WEB + '/podcast/' + pid)
  var podcast = readPageProps(res.data).podcast
  if (!podcast || !podcast.pid) throw pluginError('not-found', '小宇宙上找不到这个节目')
  pageCache[pid] = { at: Date.now(), podcast: podcast }
  return podcast
}

async function fetchEpisodePage(eid) {
  eid = String(eid || '')
  if (!ID_RE.test(eid)) throw pluginError('not-found', '不是有效的小宇宙单集')
  var res = await getText(WEB + '/episode/' + eid)
  var episode = readPageProps(res.data).episode
  if (!episode || !episode.eid) throw pluginError('not-found', '小宇宙上找不到这一期')
  return episode
}

/* ============================================================
 * 映射
 * ============================================================ */

function pickImage(image) {
  if (!image || typeof image !== 'object') return undefined
  return image.largePicUrl || image.middlePicUrl || image.picUrl || undefined
}

function timeOf(value) {
  var t = Date.parse(value)
  return isNaN(t) ? undefined : t
}

function clip(text, max) {
  if (!text) return undefined
  var s = String(text).trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 付费单集：没有公开音频 */
function isPaidEpisode(raw) {
  return !!raw && ((!!raw.payType && raw.payType !== 'FREE') || raw.isPrivateMedia === true)
}

function publicAudioUrl(raw) {
  if (!raw || isPaidEpisode(raw)) return undefined
  var source = raw.media && raw.media.source
  if (source && source.url && (!source.mode || source.mode === 'PUBLIC')) return String(source.url)
  if (raw.enclosure && raw.enclosure.url) return String(raw.enclosure.url)
  return undefined
}

function mapPodcast(raw, subscribedIds) {
  if (!raw || !raw.pid) return null
  return {
    platform: PLATFORM,
    id: String(raw.pid),
    title: String(raw.title || ''),
    artwork: pickImage(raw.image),
    description: raw.description || raw.brief || undefined,
    author: raw.author || undefined,
    episodes: typeof raw.episodeCount === 'number' ? raw.episodeCount : undefined,
    subscribers: typeof raw.subscriptionCount === 'number' ? raw.subscriptionCount : undefined,
    subscribed: subscribedIds ? !!subscribedIds[String(raw.pid)] : undefined,
    lastEpisodeAt: timeOf(raw.latestEpisodePubDate),
    // 整个节目收费才标「付费」；只有部分单集收费的（PAY_EPISODE_PODCAST）不标，单集上各自标
    paid: !!raw.payType && raw.payType !== 'FREE' && raw.payType !== 'PAY_EPISODE_PODCAST',
  }
}

function mapEpisode(raw, podcastRaw) {
  if (!raw || !raw.eid) return null
  var pod = raw.podcast || podcastRaw || {}
  return {
    platform: PLATFORM,
    id: String(raw.eid),
    title: String(raw.title || ''),
    artist: String(pod.author || ''),
    album: pod.title ? String(pod.title) : undefined,
    artwork: pickImage(raw.image) || pickImage(pod.image),
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    vip: isPaidEpisode(raw),
    /* 私有字段：音频直链，取流时直接用，省一次单集页请求 */
    audioUrl: publicAudioUrl(raw),
    podcast: {
      id: String(raw.pid || pod.pid || ''),
      title: String(pod.title || ''),
      publishedAt: timeOf(raw.pubDate),
      description: clip(raw.description, EPISODE_DESC_MAX),
    },
  }
}

/* ============================================================
 * 本地存储：订阅、粘贴过链接的单集
 * ============================================================ */

async function readJsonList(key) {
  var raw = await env.storage.get(key)
  if (!raw) return []
  try {
    var list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function writeJsonList(key, list) {
  return env.storage.set(key, JSON.stringify(list))
}

function readSubs() { return readJsonList(SUBS_KEY) }

function subscribedMap(list) {
  var ids = {}
  list.forEach(function (p) { if (p && p.id) ids[String(p.id)] = true })
  return ids
}

function snapshot(item, subscribedAt) {
  return {
    platform: PLATFORM,
    id: String(item.id),
    title: String(item.title || ''),
    artwork: item.artwork,
    author: item.author,
    episodes: item.episodes,
    subscribers: item.subscribers,
    description: clip(item.description, SNAPSHOT_DESC_MAX),
    lastEpisodeAt: item.lastEpisodeAt,
    paid: item.paid,
    subscribedAt: subscribedAt || Date.now(),
  }
}

/** 订阅过的节目打开时顺手刷新快照（期数、最新一期时间会变） */
async function refreshSnapshot(mapped) {
  var list = await readSubs()
  var i = -1
  list.forEach(function (p, idx) { if (p && String(p.id) === mapped.id) i = idx })
  if (i < 0) return
  list[i] = snapshot(mapped, list[i].subscribedAt)
  await writeJsonList(SUBS_KEY, list)
}

async function rememberEpisode(episode) {
  var pid = episode.podcast && episode.podcast.id
  if (!pid) return
  var key = PINNED_PREFIX + pid
  var list = (await readJsonList(key)).filter(function (e) { return e && e.id !== episode.id })
  list.unshift(episode)
  await writeJsonList(key, list.slice(0, PINNED_MAX))
}

/* ============================================================
 * 分享链接
 * ============================================================ */

/** 短链接一跳一跳地问 Location（宿主每一跳都重新过 hosts 白名单） */
async function expandShortLink(url) {
  var current = url
  for (var hop = 0; hop < 4; hop++) {
    var res = await getText(current, { redirect: 'manual', validateStatus: null })
    var headers = res.headers || {}
    var location = headers.location || headers.Location
    if (!location || res.status < 300 || res.status >= 400) return current
    current = new URL(String(location), current).href
    if (LINK_RE.test(current)) return current
  }
  return current
}

/** 从粘贴的文本里认出节目 / 单集；认不出返回 null */
async function resolveLink(text) {
  var s = String(text || '').trim()
  var m = LINK_RE.exec(s)
  if (!m) {
    var short = SHORT_LINK_RE.exec(s)
    if (short) m = LINK_RE.exec(await expandShortLink(short[0]))
  }
  if (m) return { kind: m[1], id: m[2] }
  if (ID_RE.test(s)) return { kind: 'unknown', id: s }
  return null
}

/* ============================================================
 * 导出
 * ============================================================ */

async function searchPodcasts(query, page) {
  if (page && page > 1) return { data: [], isEnd: true }
  var link = await resolveLink(query)
  if (!link) return { data: [], isEnd: true }

  var podcastRaw = null
  if (link.kind === 'podcast') {
    podcastRaw = await fetchPodcastPage(link.id)
  } else if (link.kind === 'episode') {
    var episode = await fetchEpisodePage(link.id)
    var mapped = mapEpisode(episode)
    if (mapped) await rememberEpisode(mapped)
    podcastRaw = await fetchPodcastPage(episode.pid || (episode.podcast && episode.podcast.pid))
  } else {
    // 裸 id：先当节目，不是再当单集
    try {
      podcastRaw = await fetchPodcastPage(link.id)
    } catch (err) {
      if (!(err && err.code === 'not-found')) throw err
      return searchPodcasts(WEB + '/episode/' + link.id, 1)
    }
  }
  var item = mapPodcast(podcastRaw, subscribedMap(await readSubs()))
  return { data: item ? [item] : [], isEnd: true }
}

async function getEpisodes(podcastItem, page, order) {
  if (page && page > 1) return { data: [], isEnd: true }
  var raw = await fetchPodcastPage(podcastItem && podcastItem.id)
  var list = (raw.episodes || []).map(function (e) { return mapEpisode(e, raw) }).filter(Boolean)
  var seen = {}
  list.forEach(function (e) { seen[e.id] = true })
  var pinned = await readJsonList(PINNED_PREFIX + raw.pid)
  pinned.forEach(function (e) { if (e && e.id && !seen[e.id]) { seen[e.id] = true; list.push(e) } })
  list.sort(function (a, b) { return (b.podcast.publishedAt || 0) - (a.podcast.publishedAt || 0) })
  if (order === 'oldest') list.reverse()
  var total = typeof raw.episodeCount === 'number' ? raw.episodeCount : list.length
  // partial：网页只给最新一批，列表不全——宿主据此不给「最早」排序、并说明原因
  return { data: list, isEnd: true, total: total, partial: total > list.length }
}

async function getMediaSource(musicItem) {
  var url = musicItem && musicItem.audioUrl
  if (url) return { url: String(url) }
  var raw = await fetchEpisodePage(musicItem && musicItem.id)
  if (isPaidEpisode(raw)) throw pluginError('forbidden', '付费单集，要在小宇宙里购买后收听')
  url = publicAudioUrl(raw)
  if (!url) throw pluginError('not-found', '这一期没有公开的音频')
  return { url: url }
}

module.exports = {
  platform: PLATFORM,
  version: '0.1.0',

  getMediaSource: getMediaSource,

  n1ko: {
    podcast: {
      search: searchPodcasts,

      getEpisodes: getEpisodes,

      async getDetail(podcastItem) {
        var raw = await fetchPodcastPage(podcastItem && podcastItem.id)
        var subs = await readSubs()
        var mapped = mapPodcast(raw, subscribedMap(subs))
        if (!mapped) throw pluginError('not-found', '小宇宙上找不到这个节目')
        if (mapped.subscribed) await refreshSnapshot(mapped)
        return mapped
      },

      async getSubscribed(page) {
        if (page && page > 1) return { data: [], isEnd: true }
        var list = await readSubs()
        var data = list
          .filter(function (p) { return p && p.id })
          .sort(function (a, b) { return (b.subscribedAt || 0) - (a.subscribedAt || 0) })
          .map(function (p) {
            var item = {}
            Object.keys(p).forEach(function (k) { if (k !== 'subscribedAt') item[k] = p[k] })
            item.subscribed = true
            return item
          })
        return { data: data, isEnd: true }
      },

      async setSubscribed(podcastItem, subscribed) {
        var id = String((podcastItem && podcastItem.id) || '')
        if (!ID_RE.test(id)) throw pluginError('not-found', '不是有效的小宇宙节目')
        var list = (await readSubs()).filter(function (p) { return p && String(p.id) !== id })
        if (subscribed) {
          // 宿主缓存没命中时回传的是最小项（只有 id），这时现读一次节目页补全快照
          var full = podcastItem && podcastItem.title ? podcastItem : mapPodcast(await fetchPodcastPage(id), null)
          list.unshift(snapshot(full))
        }
        await writeJsonList(SUBS_KEY, list)
      },
    },
    getMediaSource: getMediaSource,
  },
}
