/*!
 * iframe-bridge · 协议 v2 —— 内嵌页(iframe) / 弹出窗(window.open) 与父应用的双向通信
 * ============================================================================
 * 一个文件、两个角色，两侧对外都只有 on / emit，语义对称：
 *   子页   → 直接用全局 ScIframeBridge
 *   父应用 → ScIframeBridge.host({...}) 建桥，再 attach 到某个子窗口
 *
 * 【子页】
 *   <script src="./iframe-bridge.js"></script>
 *   ScIframeBridge.on(function (msg) {                    // 注册一次，按 msg.type 自己分支
 *     if (msg.type === 'contextChange') reload(msg.payload)
 *   })
 *   ScIframeBridge.emit('getContext').then(function (c) { use(c) })   // await = 取回执
 *   ScIframeBridge.emit('toast', { message: '已保存' })               // 不 await = 单向通知
 *
 * 【父应用】
 *   var origin = ScIframeBridge.resolveOrigin(iframe.src)   // 子页确切 origin
 *   var bridge = ScIframeBridge.host({
 *     allowedOrigins: [origin],
 *     getContext: function () { return { userName: '张伟', headerArea: '洪山区' } },
 *     onHeight: function (h) { iframe.style.height = h + 'px' }
 *   })
 *   bridge.on(function (msg) {
 *     switch (msg.type) {
 *       case 'getContext': return myContext()   // 返回值 = 给对端的回执
 *       default: return undefined               // 未处理的 type 忽略，不影响其它消息
 *     }
 *   })
 *   bridge.attach(iframe.contentWindow, origin)   // 弹窗则传 window.open() 的返回值
 *   bridge.onReady(cb) / bridge.emit(t, p) / bridge.destroy()
 *
 * 【on / emit】
 *   on(handler)          注册监听，返回取消函数；可注册多个。handler 返回值 = 回执，
 *                        抛错 = 对端 emit 变 reject。
 *   emit(type, payload)  返回 Promise；await 拿回执，不 await 即单向通知（内部吞掉 reject）。
 *   回调收到：{ type, payload } —— 只有这两个字段，其余（来源 origin、类型 req/evt、
 *   时间戳）SDK 内部已校验或消化，不往外给。需要来源时：子页读 ScIframeBridge.parentOrigin，
 *   父侧读 bridge.getTargetOrigin()。
 *
 * 【业务对接 · 问答模式 ai:ask】
 *   数智疾控以对话为主形态，父应用对外只需这一个 type，两种数据一次给全：
 *     bridge.emit('ai:ask', {
 *       content:     '请分析洪山区近一周的传染病态势',        // 上屏：渲染成用户气泡
 *       provideData: { area: '洪山区', from: '2026-09-13' }  // 不上屏：只喂给模型
 *     })
 *   · content      string（必填）用户可见的那句话，子页原样渲染成一条用户消息。
 *   · provideData  string | object | array（选填）临时提示词 / 数据，**只进模型上下文、
 *     不出现在界面上**：不渲染、不落可见历史。content 决定「用户看到什么」，
 *     provideData 决定「模型额外知道什么」。常放分析参数、选中图例、CSV 文本、筛选范围。
 *     怎么拼进请求（system 段 / 上下文段 / 函数参数）由子页自定 —— 别拼进用户气泡，
 *     否则界面上会冒出一串 JSON。
 *   · 回执 = 「已受理」不是「已答完」：子页返回 { accepted, sessionId }（新建会话带
 *     mode: 'new'，不接受则 { accepted: false, reason }）；模型产出完，由子页反向
 *     emit('ai:done', { sessionId })，父页据此收起「分析中」。
 *   · provideData 常带 CSV：受默认 8M 字符上限约束（见【关键约定】），超了 reject
 *     PAYLOAD_TOO_LARGE；几十 MB 的结构化克隆会卡主线程，大表让子页自行取数或分片。
 *   · 最小约定就是上面两个字段；需要幂等可自行加 msgId 等字段，SDK 原样透传。
 *
 *   ⚠️ 接入方（数智疾控）侧的两个硬要求 —— 收到 ai:ask 后：
 *     1) 主动提问：**不要把 content 只填进输入框等人点「发送」**。收到即视为用户已经
 *        提问，立刻以用户身份把这条 content 发出去（渲染成一条用户消息）并开始生成回答；
 *        provideData 同时用于装配本次请求的上下文（系统提示词 / 参数 / 数据），不上屏。
 *     2) 收起左侧边栏：内嵌可用宽度本就窄（iframe 浮层 / 可拖动小窗），收到 ai:ask 后要
 *        **主动收起左侧会话列表（侧边栏）**，把整幅宽度让给对话区，让回答直接可见。
 *        收起动作应与渲染同时或更早，否则会看到一帧挤压 / 抖动。
 *     幂等提醒：iframe 重载 / 握手重试 / 用户连点都会重放同一条 —— 父页带 msgId 时按
 *     msgId 去重，别开出第二个会话或重复提问。
 *
 * 【保留 type】$ 开头，SDK 内部消化、不进业务监听：
 *   $ready(子→父 握手) / $init(父→子 应答，带 context) / $height(高度上报)
 *   业务 type 不要用 $ 开头（INVALID_ARGUMENT）。
 *
 * 【关键约定】
 *   · 业务未就绪不丢消息：首条 on() 之前的入站消息先缓冲(上限 32 条)，注册后按序重放。
 *     因此 on() 的注册时机 = 「业务已就绪」的声明。
 *   · 握手完成前 emit 两侧都自动排队（默认 6s 上限），握手一到即按原序发出。
 *   · 子页对端自动探测，两种形态业务代码一行不用改：iframe → window.parent；
 *     window.open 弹窗 → window.opener；都没有（地址栏直开）→ emit 立即 reject
 *     NOT_CONNECTED，不空等。用 noopener 打开则拿不到 opener，无解。
 *   · 体量上限默认 8M 字符（中文 1 字符 = UTF-8 3 字节），超了 reject 不静默丢；
 *     maxPayloadSize: 0 / Infinity 关闭该限制。大块数据请分片 —— 结构化克隆是同步的，
 *     几十 MB 会卡死主线程。
 *   · emit 默认等回执 4s，等的是「对端受理」不是业务结果，可按次覆盖：emit(t, p, 8000)。
 *   · 安全：出站绝不用 '*'；入站过 频道 + 版本 + 来源窗口 + origin 白名单 四道校验。
 *     令牌由 host({ allowToken }) 与 bridge.canShareToken(origin) 决定是否下发；
 *     不想凭证离开父窗口，就让子页 emit('request') 由父应用代发接口。
 *   · 本文件零依赖、ES5，直接 <script> 引入，不要用 import。
 *
 * 【错误码】INVALID_ARGUMENT / NOT_CONNECTED / TIMEOUT / PAYLOAD_TOO_LARGE / FORBIDDEN
 *   （其余如 NOT_SUPPORTED 由业务代码给出，原样透传）
 *
 * 【自动高度】子页 URL 带 autoHeight=1 时自动上报内容高度，父侧在 onHeight 里调 iframe 高度；
 *   手动关：ScIframeBridge.autoHeight = false
 *
 * 【本目录三个文件（temp/，不入库）】
 *   iframe-bridge.js  本文件，唯一真源
 *   biz.html          父页薄壳：点按钮以 iframe(400×400 居中浮层) 或 window.open(可拖动小窗)
 *                     打开子页，两种方式父侧代码完全一样
 *   child.html        业务发生地：故意延迟 2s 就绪，就绪后主动 emit 向父页要上下文再渲染；
 *                     收到 ai:ask 后照【业务对接 · 问答模式】的两条硬要求执行 ——
 *                     主动把 content 发出去 + 自动收起左侧会话栏（留了手动开关便于反复验证）
 *   跑法：静态服务从仓库根目录打开 biz.html（如 http://127.0.0.1:5500/temp/iframe-bridge/biz.html）。
 *   别用工程自己的 vite dev server —— createHtmlPlugin 会把任意 HTML 替换成应用入口。
 *
 * 【排错】控制台看 [iframe-bridge] 前缀日志。子页 ScIframeBridge.connected / .context /
 *   .embedded / .peer / .height；父侧 bridge.isReady() / bridge.getTargetOrigin()。
 * ============================================================================
 */
(function (global) {
	'use strict'

	/** 频道标识：父页面可能存在多个 iframe / 多个 postMessage 使用方，用该字段过滤无关消息 */
	var CHANNEL = 'sc-iframe-bridge'
	/** 协议版本：不匹配直接丢弃，避免新旧版本互相误解析 */
	var VERSION = 2

	/** 保留 type：$ 开头，SDK 内部消化，不派发给业务监听函数 */
	var RESERVED = {
		READY: '$ready',
		INIT: '$init',
		HEIGHT: '$height'
	}

	var ERR = {
		INVALID_ARGUMENT: 'INVALID_ARGUMENT',
		FORBIDDEN: 'FORBIDDEN',
		NOT_CONNECTED: 'NOT_CONNECTED',
		TIMEOUT: 'TIMEOUT',
		PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
		INTERNAL: 'INTERNAL',
		NOT_SUPPORTED: 'NOT_SUPPORTED'
	}

	var DEFAULTS = {
		/**
		 * 单次 emit 等待回执的超时。
		 * 注意等的是「对端受理回执」（比如 { sessionId }），不是业务执行结果 ——
		 * 模型出结果走 evt 推送，不能让 req-res 干等。要更长按次覆盖：emit(t, p, 8000)。
		 */
		timeout: 4000,
		/**
		 * 握手等待上限：握手完成前的 emit 最多排这么久。
		 * 这是「排队上限」不是「用户干等时长」—— 消息排着队，握手一到就自动发出去，
		 * 用户看到的是"已排队"而不是"失败"。所以这个值大一点无害，小一点反而会在弱网
		 * 把正常首次点击判成失败（首次加载 + 业务就绪实测约 2.4s，这里留 2.5 倍余量）。
		 */
		connectTimeout: 6000,
		/**
		 * 单条消息体量上限，单位是**字符数**不是字节数
		 * （中文 1 个字符 = UTF-8 3 字节，所以 8M 字符最坏约 24MB 字节）。
		 * 传 0 或 Infinity = 不限制。
		 *
		 * 为什么默认留个上限而不是干脆不限：上限不是为了讨好浏览器（规范里确实没有
		 * 大小规定），而是拦住「把几十万行 CSV 塞进一条消息」这种误用 —— 结构化克隆是
		 * 同步的，几十 MB 会让主线程卡死数秒、内存翻两三倍，且失败是静默的。
		 * 真有大块数据请走分片（见 output/疾控大脑嵌入-业务改造指南.md）。
		 */
		maxPayloadSize: 8 * 1024 * 1024,
		/** 握手重试间隔（父侧监听器可能晚于本脚本就绪） */
		handshakeInterval: 300,
		/** 握手最大重试次数（300 × 16 ≈ 4.8s，与 connectTimeout 同量级） */
		handshakeMaxRetry: 16,
		/** 高度上报节流间隔 */
		heightThrottle: 120
	}

	/**
	 * 读一个数值选项：显式传的合法数字优先，否则回落到默认值。
	 * 用 typeof 判断而不是 `||`，因为 `0` 是合法输入（表示"不限制"），
	 * 用 `||` 会被当成假值吃掉、悄悄回落到默认值 —— 那是配了却不生效的暗坑。
	 * 允许 Infinity（"不限"的另一种写法）；NaN / 负数视为没传。
	 */
	function pickNumber (value, fallback) {
		if (typeof value !== 'number' || value < 0 || isNaN(value)) return fallback
		return value
	}

	/** 体量上限是否生效（0 与 Infinity 都表示不限制） */
	function limitEnabled (limit) {
		return limit > 0 && limit !== Infinity
	}

	// ---------------------------------------------------------------- 小工具

	function noop () {}

	function makeError (code, message) {
		return { code: code, message: message }
	}

	function isObject (value) {
		return !!value && typeof value === 'object'
	}

	/** 保留 type 一律以 $ 开头，业务 type 禁止占用 */
	function isReserved (type) {
		return typeof type === 'string' && type.charAt(0) === '$'
	}

	/** 安全序列化：用于体量评估，循环引用等异常情况返回空串（不阻断主流程） */
	function safeStringify (value) {
		try {
			return JSON.stringify(value) || ''
		} catch (e) {
			return ''
		}
	}

	/**
	 * 量一条消息的体量（字符数），**只量一次，结果沿调用链带下去**。
	 *   - 字符串载荷（CSV、data:URL 这类内联大数据正好都是字符串）直接取 .length，
	 *     零序列化成本 —— 老实现每次都 JSON.stringify 整个大字符串只为量个长度，
	 *     在 8MB 级载荷上要凭空多趟一遍并生成同量级的临时字符串。
	 *   - 其余类型才 stringify（这是没法省的那次）。
	 * 信封（ch/v/kind/id/ts 等）约几十字符，这里用 type.length 粗略抵掉；
	 * 对 MB 级的判断不构成误差，但能保证结果**不小于**真实体量。
	 */
	function measure (type, payload) {
		var envelope = typeof type === 'string' ? type.length : 0
		if (typeof payload === 'string') return payload.length + envelope
		if (payload === undefined || payload === null) return envelope
		return safeStringify({ type: type, payload: payload }).length
	}

	/** 体量是否超限 */
	function tooLarge (limit, size) {
		return limitEnabled(limit) && size > limit
	}

	/** origin 归一化：'http://a.com/' 与 'http://a.com' 视为同一个 */
	function normalizeOrigin (origin) {
		var raw = String(origin || '').trim()
		if (!raw) return ''
		if (raw === '*') return '*'
		var matched = raw.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i)
		if (matched) return matched[1].toLowerCase().replace(/\/+$/, '')
		return raw.replace(/\/+$/, '').toLowerCase()
	}

	function originFromUrl (url) {
		if (!url) return ''
		try {
			return new URL(url).origin
		} catch (e) {
			return ''
		}
	}

	/** 当前页面协议；非 http(s)（file: / about:）时回退 http:，避免拼出无法校验的 origin */
	function pageProtocol () {
		var protocol = (global && global.location && global.location.protocol) || ''
		return /^https?:$/i.test(protocol) ? protocol : 'http:'
	}

	/** 当前页面 origin；非 http(s) 页面返回 ''（此时无法做 origin 校验，桥将拒绝绑定） */
	function pageOrigin () {
		var origin = (global && global.location && global.location.origin) || ''
		return /^https?:\/\//i.test(origin) ? origin : ''
	}

	/**
	 * 由目标地址解析出确切的 origin（父应用侧计算 iframe.src 用）
	 * - 绝对地址 http(s)://ip:port/xxx   → 解析结果的 origin
	 * - 协议相对地址 //ip:port/xxx       → 补当前页面协议后解析
	 * - 无协议的 ip:port/xxx             → 先补 // 再解析
	 * - 相对路径 static/html/xxx.html    → 与当前页面同源
	 * 解析失败、或当前页面本身不是 http(s) 时返回 ''
	 */
	function resolveOrigin (src, base) {
		var raw = String(src || '').trim()
		if (!raw) return ''
		try {
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw).origin
			var protocolRelative = /^[a-z0-9][a-z0-9.-]*:\d{2,5}(?:\/|$)/i.test(raw) ? '//' + raw : raw
			if (protocolRelative.indexOf('//') === 0) return new URL(pageProtocol() + protocolRelative).origin
			if (base) return new URL(raw, base).origin
			return pageOrigin()
		} catch (e) {
			return ''
		}
	}

	/** 由自身 URL 判断是否要上报高度：菜单 linkUrl 带 autoHeight=1 时开启 */
	function detectAutoHeight (win) {
		try {
			var search = (win && win.location && win.location.search) || ''
			return /(?:^|[?&])autoHeight=1(?:&|$)/.test(search)
		} catch (e) {
			return false
		}
	}

	// ============================================================ 子页侧
	// 子页用的桥：对端是「嵌它的那一层」—— iframe 场景是 window.parent，
	// window.open 弹窗场景是 window.opener。子页业务代码两种形态通用。

	/**
	 * 创建子页侧桥
	 * @param {Object} env 运行环境（默认取真实浏览器环境，测试时可注入）
	 *   - self               内嵌页 window
	 *   - parent             父窗口（一般为 window.parent）
	 *   - referrer           父页面地址（document.referrer），用于提前推断父源
	 *   - timeout            单次 emit 回执超时，默认 4000ms（emit 第三参数传数字可按次覆盖）
	 *   - connectTimeout     握手等待上限，默认 6000ms
	 *   - maxPayloadSize     单条消息体量上限（**字符数**），默认 8M；0 / Infinity = 不限制
	 *   - handshakeInterval  握手重试间隔，默认 300ms
	 *   - handshakeMaxRetry  握手最大重试次数，默认 16
	 *   - heightThrottle     高度上报节流间隔，默认 120ms
	 *   - autoHeight         是否自动上报内容高度；不传则按自身 URL 的 autoHeight=1 判断
	 *   - logger             日志函数 (level, message, detail)
	 */
	function createPageSide (env) {
		env = env || {}
		var self = env.self || global

		// 对端窗口有两条来路，二选一：
		//   ① iframe 内嵌    → window.parent 是另一个窗口
		//   ② window.open 弹窗 → 没有 parent（parent === self），但 opener 指向开它的那个窗口
		// 两者都没有（地址栏直接打开本页）时，后面 emit 会立刻 reject，不白等超时。
		var parentWindow = env.parent || (self && self.parent) || null
		var openerWindow = env.opener !== undefined
			? env.opener
			: ((self && self.opener) || null)

		var inFrame = !!parentWindow && parentWindow !== self
		var peerWindow = inFrame
			? parentWindow
			: (openerWindow && openerWindow !== self ? openerWindow : null)

		/** 'iframe' | 'popup' | 'standalone'，只用于日志与报错措辞 */
		var peerKind = inFrame ? 'iframe' : (peerWindow ? 'popup' : 'standalone')
		/** 有没有对端（iframe、弹窗都算）—— 没有时 emit 直接拒绝，避免无意义等待 */
		var embedded = !!peerWindow

		var logger = env.logger || noop
		var timeout = pickNumber(env.timeout, DEFAULTS.timeout)
		var connectTimeout = pickNumber(env.connectTimeout, DEFAULTS.connectTimeout)
		var maxPayloadSize = pickNumber(env.maxPayloadSize, DEFAULTS.maxPayloadSize)
		var handshakeInterval = pickNumber(env.handshakeInterval, DEFAULTS.handshakeInterval)
		var handshakeMaxRetry = pickNumber(env.handshakeMaxRetry, DEFAULTS.handshakeMaxRetry)
		var heightThrottle = pickNumber(env.heightThrottle, DEFAULTS.heightThrottle)

		var seq = 0
		var pending = {}
		/** 监听函数列表：注册一次即收到全部消息，靠 type 自己分支 */
		var handlers = []
		/** 握手完成前的待发 emit */
		var waiting = []
		var connected = false
		/** onReady 订阅者 */
		var readySinks = []
		/** 业务未就绪（尚未注册任何 on）期间收到的父页请求，等第一条 on 注册后重放 */
		var earlyInbound = []
		var EARLY_INBOUND_MAX = 32
		var context = {}
		var retryTimer = null
		var retryCount = 0
		var heightBound = false
		var heightObserver = null
		var autoHeightOn = typeof env.autoHeight === 'boolean' ? env.autoHeight : detectAutoHeight(self)

		// 先按 referrer 推断父源；拿不到就等父应用 $init 时锁定
		var parentOrigin = originFromUrl(env.referrer || (self && self.document && self.document.referrer) || '')

		function log (level, message, detail) {
			try {
				logger(level, message, detail)
			} catch (e) {
				/* 日志失败不影响主流程 */
			}
		}

		/** 出站投递；未锁定对端源时只能发到 '*'，故严禁在此阶段放敏感数据 */
		function post (message) {
			if (!peerWindow || typeof peerWindow.postMessage !== 'function') return false
			var targetOrigin = parentOrigin || '*'
			try {
				peerWindow.postMessage(message, targetOrigin)
				return true
			} catch (e) {
				log('error', 'iframe-bridge: postMessage 失败', e)
				return false
			}
		}

		function postEvent (type, payload) {
			return post({
				ch: CHANNEL,
				v: VERSION,
				kind: 'evt',
				type: type,
				payload: typeof payload === 'undefined' ? null : payload,
				ts: Date.now()
			})
		}

		// -------------------------------------------------------- 触发（emit）

		/** 握手完成前的 emit 先排队，$init 到达后按原顺序发出 */
		function enqueue (type, payload) {
			return new Promise(function (resolve, reject) {
				var item = { type: type, payload: payload, resolve: resolve, reject: reject }
				waiting.push(item)
				item.timer = setTimeout(function () {
					var index = waiting.indexOf(item)
					if (index > -1) waiting.splice(index, 1)
					reject(makeError(ERR.NOT_CONNECTED, '等待父应用握手超时（' + connectTimeout + 'ms），未能触发：' + type))
				}, connectTimeout)
			})
		}

		function sendRequest (type, payload) {
			return new Promise(function (resolve, reject) {
				// 上限关掉时连量都不用量（量一条 MB 级载荷就是一趟全遍历 + 同量级临时字符串）
				if (limitEnabled(maxPayloadSize)) {
					var size = measure(type, payload)
					if (size > maxPayloadSize) {
						reject(makeError(ERR.PAYLOAD_TOO_LARGE, '载荷体量超限（' + size + ' > ' + maxPayloadSize + ' 字符），已拦截：' + type))
						return
					}
				}
				seq += 1
				var id = 'c-' + seq + '-' + Date.now().toString(36)
				var timer = setTimeout(function () {
					delete pending[id]
					reject(makeError(ERR.TIMEOUT, '父应用未在超时时间内应答：' + type))
				}, timeout)
				pending[id] = { resolve: resolve, reject: reject, timer: timer }
				var sent = post({
					ch: CHANNEL,
					v: VERSION,
					kind: 'req',
					type: type,
					id: id,
					payload: typeof payload === 'undefined' ? null : payload,
					ts: Date.now()
				})
				if (!sent) {
					clearTimeout(timer)
					delete pending[id]
					reject(makeError(ERR.NOT_CONNECTED, '消息发送失败，当前可能没有对端窗口（既不在 iframe 中，也没有 opener）：' + type))
				}
			})
		}

		function flushWaiting () {
			var items = waiting.slice()
			waiting.length = 0
			items.forEach(function (item) {
				clearTimeout(item.timer)
				sendRequest(item.type, item.payload).then(item.resolve, item.reject)
			})
		}

		/**
		 * 触发：向父应用发一条消息，返回 Promise
		 * - await           → 拿到父应用监听函数的返回值
		 * - 不 await        → 单向通知（不会产生 unhandledrejection）
		 * - 父应用没处理该 type → resolve(undefined)，不抛错（只在日志里提示）
		 * - 父应用处理函数抛错 → reject，error.code 由父侧给出
		 */
		function emit (type, payload) {
			var promise
			if (typeof type !== 'string' || !type) {
				promise = Promise.reject(makeError(ERR.INVALID_ARGUMENT, 'emit 的第一个参数必须是非空字符串：消息 type'))
			} else if (isReserved(type)) {
				promise = Promise.reject(makeError(ERR.INVALID_ARGUMENT, 'emit 的 type 不能以 $ 开头（$ 是 SDK 保留前缀）：' + type))
			} else if (!embedded) {
				promise = Promise.reject(makeError(ERR.NOT_CONNECTED, '当前页面既不在 iframe 中也没有 window.opener（地址栏直接打开本页），无法与父应用通信：' + type))
			} else if (!connected) {
				promise = enqueue(type, payload)
			} else {
				promise = sendRequest(type, payload)
			}
			// 允许调用方不 await（当成单向通知用）而不产生 unhandledrejection 噪音；
			// 这里只挂一个空处理器，promise 本身仍然会把 reject 交给 await / .catch 的调用方
			promise.catch(noop)
			return promise
		}

		// -------------------------------------------------------- 监听（on）

		/** 注册监听，返回取消监听的函数。可注册多个，每个都会收到全部消息 */
		function on (handler) {
			if (typeof handler !== 'function') {
				log('warn', 'iframe-bridge: on(handler) 需要传入函数，已忽略')
				return noop
			}
			handlers.push(handler)
			// 第一条监听注册 = 业务已就绪的信号，此时重放此前的缓冲消息
			if (handlers.length === 1) scheduleDrainEarly()
			return function () {
				off(handler)
			}
		}

		/**
		 * 重放业务就绪前缓冲的父页请求。
		 * 放到下一个宏任务：给业务一个「注册完 on 之后还能同步做初始化」的机会，
		 * 否则 handler 会在 on() 语句内部就被同步调用。
		 */
		function scheduleDrainEarly () {
			setTimeout(function () {
				if (!earlyInbound.length) return
				var items = earlyInbound.slice()
				earlyInbound.length = 0
				items.forEach(function (item) {
					handleInbound(item)
				})
				log('info', 'iframe-bridge: 已重放业务就绪前的缓冲消息', { count: items.length })
			}, 0)
		}

		function off (handler) {
			if (typeof handler !== 'function') {
				handlers = []
				return
			}
			handlers = handlers.filter(function (item) {
				return item !== handler
			})
		}

		/**
		 * 按顺序执行监听函数
		 * @param {boolean} wantResult 需要回执时取第一个非 undefined 的返回值；有异常则抛给触发方
		 */
		function runHandlers (packet, wantResult) {
			var list = handlers.slice()
			var result
			var failure
			var chain = Promise.resolve()
			list.forEach(function (handler) {
				chain = chain.then(function () {
					return Promise.resolve()
						.then(function () {
							return handler(packet)
						})
						.then(function (value) {
							if (typeof result === 'undefined' && typeof value !== 'undefined') result = value
						})
						.catch(function (e) {
							if (typeof failure === 'undefined') failure = e
							log('error', 'iframe-bridge: 监听函数异常 ' + packet.type, e)
						})
				})
			})
			return chain.then(function () {
				if (wantResult) {
					if (typeof failure !== 'undefined') throw failure
					return result
				}
				return undefined
			})
		}

		function reply (request, payload, err) {
			var message = {
				ch: CHANNEL,
				v: VERSION,
				kind: 'res',
				type: request.type,
				id: request.id,
				ok: !err,
				ts: Date.now()
			}
			if (err) {
				message.error = err
			} else if (typeof payload !== 'undefined') {
				message.payload = payload
			} else {
				// 没有返回值（一条监听都没注册，或处理函数没返回）：不带 payload 并标记 nh，
				// 让触发方 resolve(undefined) —— 语义统一，触发方不必区分「没人管」和「返回了空」
				message.nh = true
			}
			post(message)
		}

		/** 父应用发来的请求（父 → 子）：跑监听函数并回执 */
		function handleInbound (message) {
			if (!handlers.length) {
				// 业务还没注册监听（典型的「SDK 就绪但业务未就绪」窗口期）：
				// 先缓冲，等第一条 on() 注册后重放 —— 否则父页「进页面就点按钮」的指令会丢。
				// 这里刻意不回执：等真正处理完再回，父页的 await 才能拿到真实结果。
				if (earlyInbound.length >= EARLY_INBOUND_MAX) {
					earlyInbound.shift()
					log('warn', 'iframe-bridge: 早期消息缓冲已满，丢弃最旧的一条', { type: message.type })
				}
				earlyInbound.push(message)
				log('info', 'iframe-bridge: 业务未就绪，消息已缓冲等待重放', { type: message.type, buffered: earlyInbound.length })
				return
			}
			runHandlers(buildPacket(message), true).then(
				function (value) {
					reply(message, value, null)
				},
				function (e) {
					reply(message, null, makeError((e && e.code) || ERR.INTERNAL, (e && e.message) || '内嵌页处理异常'))
				}
			)
		}

		/** 组装交给监听函数的消息包：只给 type + payload，其余是协议内部字段 */
		function buildPacket (message) {
			return {
				type: message.type,
				payload: message.payload
			}
		}

		// -------------------------------------------------------- 入站

		function onMessage (event) {
			var message = event && event.data
			if (!isObject(message)) return
			// 频道 + 协议版本
			if (message.ch !== CHANNEL || message.v !== VERSION) return
			// 来源窗口：必须来自对端窗口（iframe 的父窗口 / window.open 的开启者）
			if (peerWindow && event.source && event.source !== peerWindow) return
			var origin = normalizeOrigin(event.origin)
			// 已锁定父源后，来源不匹配一律丢弃
			if (parentOrigin && origin !== parentOrigin) return
			// $init 无论以 evt 还是 req 送达都可用于锁定父源（父侧按 req 发，只认 evt 会导致
			// 拿不到 referrer 时永远握不上手）
			if (!parentOrigin && message.type === RESERVED.INIT) {
				// 极端情况下拿不到 referrer，此时以 $init 的来源为准并锁定，避免后续仍以 '*' 出站
				parentOrigin = origin
				log('warn', 'iframe-bridge: 未能从 referrer 推断父源，已按 $init 来源锁定', { parentOrigin: parentOrigin })
			}
			if (!parentOrigin) return
			if (typeof message.type !== 'string' || !message.type) return

			if (message.kind === 'res') {
				handleResponse(message)
				return
			}

			// 保留 type：SDK 内部消化，不派发给业务监听函数
			if (isReserved(message.type)) {
				handleReserved(message)
				return
			}

			// 业务消息：派发
			if (message.type === 'contextChange') mergeContext(message.payload)
			if (message.kind === 'req') {
				handleInbound(message)
				return
			}
			// 单向通知：不关心返回值与异常
			runHandlers(buildPacket(message), false)
		}

		/** 保留 type 的内部处理：握手 / 高度 */
		function handleReserved (message) {
			if (message.type === RESERVED.INIT) {
				handleInit(message)
				if (message.kind === 'req') reply(message, { protocolVersion: VERSION }, null)
				return
			}
			// 其余保留 type（$ready / $height）只应出现在出站方向，入站直接忽略
			log('warn', 'iframe-bridge: 收到未知的保留 type，已忽略：' + message.type)
		}

		function handleInit (message) {
			var payload = message.payload || {}
			context = payload.context || {}
			context.protocolVersion = payload.protocolVersion
			markConnected()
		}

		/** 上下文增量补丁：只覆盖父应用明确给出的字段 */
		function mergeContext (patch) {
			if (!isObject(patch)) return
			Object.keys(patch).forEach(function (key) {
				context[key] = patch[key]
			})
		}

		function handleResponse (message) {
			var item = message.id && pending[message.id]
			if (!item) return
			delete pending[message.id]
			clearTimeout(item.timer)
			if (!message.ok) {
				item.reject(message.error || makeError(ERR.INTERNAL, '父应用处理失败'))
				return
			}
			if (message.nh) {
				log('warn', 'iframe-bridge: 父应用未处理该 type，本次触发无处理者：' + message.type)
			}
			item.resolve(message.payload)
		}

		// -------------------------------------------------------- 握手

		function markConnected () {
			var firstConnect = !connected
			connected = true
			if (retryTimer) {
				clearTimeout(retryTimer)
				retryTimer = null
			}
			// 先回放排队的 emit，再通知订阅者：保持 FIFO，业务回调里的消息排在历史之后
			flushWaiting()
			if (firstConnect) fireReady()
		}

		/** 就绪通知：先回放队列（已在 markConnected 完成），再依次调用订阅者 */
		function fireReady () {
			readySinks.slice().forEach(function (cb) {
				try {
					cb()
				} catch (e) {
					log('error', 'iframe-bridge: onReady 回调异常', e)
				}
			})
		}

		/**
		 * 与父应用握手完成时回调（注册时已连接则立即执行）。
		 * 需要「连上之后才发敏感数据」时用它，不必自己轮询 connected。
		 * @returns {Function} 取消订阅
		 */
		function onReady (callback) {
			if (typeof callback !== 'function') {
				log('warn', 'iframe-bridge: onReady 需要传入函数，已忽略')
				return noop
			}
			if (connected) {
				try {
					callback()
				} catch (e) {
					log('error', 'iframe-bridge: onReady 回调异常', e)
				}
				return noop
			}
			readySinks.push(callback)
			return function () {
				readySinks = readySinks.filter(function (item) {
					return item !== callback
				})
			}
		}

		/** 握手：反复发 $ready，直到收到父应用 $init（父侧监听器可能晚于本脚本就绪） */
		function sayReady () {
			if (connected || !embedded) return
			postEvent(RESERVED.READY, {})
			retryCount += 1
			if (retryCount > handshakeMaxRetry) {
				log('warn', 'iframe-bridge: 握手未成功，父应用可能未接入通信桥（不影响使用的页面可忽略）')
				return
			}
			// 退避：前几次快重试，之后放慢，避免无谓刷屏
			retryTimer = setTimeout(sayReady, retryCount <= 3 ? handshakeInterval : handshakeInterval * 3)
		}

		// -------------------------------------------------------- 高度自适应

		function measureHeight () {
			var doc = self && self.document
			if (!doc) return 0
			var body = doc.body || {}
			var root = doc.documentElement || {}
			return Math.max(body.scrollHeight || 0, body.offsetHeight || 0, root.scrollHeight || 0, root.offsetHeight || 0)
		}

		function reportHeight () {
			return postEvent(RESERVED.HEIGHT, { height: measureHeight() })
		}

		function bindAutoHeight () {
			if (heightBound || !self || !self.document) return
			heightBound = true
			var throttled = null
			var onChange = function () {
				if (throttled) return
				throttled = setTimeout(function () {
					throttled = null
					reportHeight()
				}, heightThrottle)
			}
			if (typeof self.ResizeObserver === 'function') {
				try {
					heightObserver = new self.ResizeObserver(onChange)
					heightObserver.observe(self.document.documentElement)
				} catch (e) {
					heightObserver = null
				}
			}
			if (!heightObserver && typeof self.MutationObserver === 'function') {
				heightObserver = new self.MutationObserver(onChange)
				heightObserver.observe(self.document.documentElement, { childList: true, subtree: true, attributes: true })
			}
			self.addEventListener('resize', onChange)
			// 首次上报
			setTimeout(reportHeight, 0)
		}

		function unbindAutoHeight () {
			heightBound = false
			if (heightObserver && typeof heightObserver.disconnect === 'function') heightObserver.disconnect()
			heightObserver = null
		}

		// -------------------------------------------------------- 公开接口

		var api = {
			/** 协议版本（排查用） */
			version: VERSION,
			/** 频道标识（排查用） */
			channel: CHANNEL,

			/** 监听：on(handler) → 取消监听的函数。注册一次即可，回调里按 msg.type 分支 */
			on: on,
			/** 取消监听：off(handler) 取消指定；off() 取消全部 */
			off: off,
			/** 触发：emit(type, payload) → Promise（await 取回执；不 await 即单向通知） */
			emit: emit,

			/** 是否已与父应用握手完成 */
			get connected () {
				return connected
			},

			/** 与父应用握手完成时回调：onReady(cb) → 取消订阅（注册时已连接则立即执行） */
			onReady: onReady,

			/** 父应用下发的上下文（$init 后有值；父应用推 contextChange 时会自动增量合并） */
			get context () {
				return context
			},

			/** 已锁定的父源（排查用） */
			get parentOrigin () {
				return parentOrigin
			},

			/** 对端形态：'iframe'（被内嵌）/ 'popup'（被 window.open 弹窗打开）/ 'standalone'（直接打开，无人通信） */
			get peer () {
				return peerKind
			},

			/** 有没有对端（iframe 或弹窗都算；standalone 时为 false，此时 emit 会直接失败） */
			get embedded () {
				return embedded
			},

			/** 最近一次上报的内容高度（排查用） */
			get height () {
				return measureHeight()
			},

			/** 销毁：解绑监听、拒绝所有挂起请求；单页应用切走时调用，普通静态页无需调用 */
			destroy: function () {
				if (self && typeof self.removeEventListener === 'function') self.removeEventListener('message', onMessage, false)
				if (retryTimer) clearTimeout(retryTimer)
				retryTimer = null
				unbindAutoHeight()
				waiting.forEach(function (item) {
					clearTimeout(item.timer)
					item.reject(makeError(ERR.NOT_CONNECTED, '通信桥已销毁'))
				})
				waiting = []
				Object.keys(pending).forEach(function (id) {
					clearTimeout(pending[id].timer)
					pending[id].reject(makeError(ERR.NOT_CONNECTED, '通信桥已销毁'))
				})
				pending = {}
				handlers = []
				readySinks = []
				earlyInbound = []
			},

			/** 保留 type 一览（排查用，业务不要用这些名字） */
			reserved: RESERVED,

			/** 仅测试使用：注入自定义运行环境 */
			__create: createPageSide
		}

		// 高度自动上报是「配置项」而不是函数：默认按 URL 的 autoHeight=1 判断，可随时改
		Object.defineProperty(api, 'autoHeight', {
			enumerable: true,
			get: function () {
				return autoHeightOn
			},
			set: function (value) {
				autoHeightOn = !!value
				if (autoHeightOn) bindAutoHeight()
				else unbindAutoHeight()
			}
		})

		if (self && typeof self.addEventListener === 'function') self.addEventListener('message', onMessage, false)
		if (autoHeightOn) bindAutoHeight()
		sayReady()

		return api
	}

	// ============================================================ 父应用侧
	// 父应用（嵌 iframe 的那个页面）用的桥：对端是某个具体的 iframe.contentWindow。

	/**
	 * 创建父应用侧桥
	 * @param {Object} options
	 *   - remote             对端 window（iframe.contentWindow，或 window.open 的返回值）
	 *   - targetOrigin       对端确切 origin，务必用 resolveOrigin(src) 计算（禁止 '*'）
	 *                       没传 remote/targetOrigin 时，稍后用 bridge.attach() 绑定
	 *   - allowedOrigins     origin 白名单（必须显式给出，禁止 '*'）
	 *   - getContext()       握手（$init）时下发给子页的上下文
	 *   - onHeight(h)        收到子页 $height 上报时回调
	 *   - autoContextChange  握手后是否自动推一条完整 contextChange，默认 true
	 *   - allowToken         是否向子页下发令牌：false（默认）| 'same-origin' | string[] | true
	 *   - timeout            emit 等待回执的超时，默认 4000ms（emit 第三参数传数字可按次覆盖）
	 *   - connectTimeout     握手等待上限（未握手时消息的排队上限），默认 6000ms
	 *   - maxPayloadSize     单条消息体量上限（**字符数**），默认 8M；0 / Infinity = 不限制
	 *   - localWindow        接收消息的 window，默认全局（测试可注入）
	 *   - logger(level, message, detail)
	 */
	function createHostSide (options) {
		options = options || {}
		var localWindow = options.localWindow || global
		var logger = options.logger || noop
		var allowedOrigins = (options.allowedOrigins || [])
			.map(normalizeOrigin)
			.filter(function (origin) {
				return !!origin && origin !== '*'
			})

		var remote = null
		var targetOrigin = ''
		var attached = false
		var ready = false
		var seq = 0
		var pending = {}
		/** 握手完成前的出站队列（FIFO），收到子页 $ready 后按原顺序回放 */
		var outbox = []
		/** onReady 订阅者 */
		var readySinks = []
		/** 监听函数列表：注册一次即收到全部消息，靠 type 自己分支 */
		var handlers = []

		function log (level, message, detail) {
			try {
				logger(level, message, detail)
			} catch (e) {
				/* 日志失败不影响主流程 */
			}
		}

		function maxPayloadSize () {
			return pickNumber(options.maxPayloadSize, DEFAULTS.maxPayloadSize)
		}

		/** 出站队列的最长等待（自入队起算），到点仍没握手成功就逐条 reject */
		function queueTimeout () {
			return pickNumber(options.connectTimeout, DEFAULTS.connectTimeout)
		}

		function isSameOrigin (origin) {
			var local = pageOrigin()
			return !!local && normalizeOrigin(origin) === normalizeOrigin(local)
		}

		function nextId (prefix) {
			seq += 1
			return prefix + '-' + seq + '-' + Date.now().toString(36)
		}

		function rejectAllPending (error) {
			Object.keys(pending).forEach(function (id) {
				clearTimeout(pending[id].timer)
				pending[id].reject(error)
			})
			pending = {}
		}

		// -------------------------------------------------------- 绑定 / 解绑

		/**
		 * 绑定通信目标
		 * @param {Object} nextRemote       对端 window
		 * @param {string} nextTargetOrigin 对端确切 origin（禁止 '*'）
		 * @returns {boolean} 是否绑定成功
		 */
		function attach (nextRemote, nextTargetOrigin) {
			var origin = normalizeOrigin(nextTargetOrigin)
			// 先校验、再改状态：非法入参不应该把已有的绑定搞坏
			if (!nextRemote || typeof nextRemote.postMessage !== 'function') {
				log('warn', 'iframe-bridge(host): attach 失败，对端不是可用的 window')
				return false
			}
			if (!origin || origin === '*') {
				log('warn', 'iframe-bridge(host): targetOrigin 非法，拒绝绑定（禁止使用 * ）')
				return false
			}
			if (allowedOrigins.indexOf(origin) === -1) {
				log('warn', 'iframe-bridge(host): targetOrigin 不在白名单内，拒绝绑定', { origin: origin, allowed: allowedOrigins })
				return false
			}
			// 同一个 window + 同一个 origin 重复 attach 是常态（页面挂载时先绑一次、
			// iframe 的 load 事件再绑一次）。此时必须保持已握手状态，也不能把挂起请求全拒掉，
			// 否则会把 ready 悄悄清成 false，表现为「明明通了却显示未握手」。
			if (attached && remote === nextRemote && targetOrigin === origin) return true

			// 目标确实变了：解绑旧目标（移除监听、清 ready、拒绝旧请求）后重新绑定
			detach()
			remote = nextRemote
			targetOrigin = origin
			attached = true
			ready = false
			if (localWindow && typeof localWindow.addEventListener === 'function') {
				localWindow.addEventListener('message', onMessage, false)
			}
			return true
		}

		/** 解绑：移除监听、拒绝所有挂起请求 */
		function detach () {
			if (attached && localWindow && typeof localWindow.removeEventListener === 'function') {
				try {
					localWindow.removeEventListener('message', onMessage, false)
				} catch (e) {
					/* 忽略：少数环境可能不支持 */
				}
			}
			attached = false
			ready = false
			remote = null
			targetOrigin = ''
			rejectAllPending(makeError(ERR.NOT_CONNECTED, '通信桥已解绑'))
		}

		/** 页面 / 组件销毁时调用 */
		function destroy () {
			detach()
			outbox.forEach(function (item) {
				clearTimeout(item.timer)
				item.reject(makeError(ERR.NOT_CONNECTED, '通信桥已销毁'))
			})
			outbox = []
			readySinks = []
			handlers = []
		}

		/** 是否已握手完成（已收到子页 $ready 并应答） */
		function isReady () {
			return ready
		}

		/** 当前绑定的对端 origin */
		function getTargetOrigin () {
			return targetOrigin
		}

		// -------------------------------------------------------- 监听 / 触发

		/**
		 * 监听子页发来的全部消息，返回取消监听的函数
		 * - 注册一次即可，回调里按 packet.type 分支；可注册多个，每个都收到全部消息
		 * - 回调返回值会作为回执；多个回调时取第一个非 undefined 的返回值
		 * - 回调里抛出的异常对象若带 code，会原样作为错误码回给子页（如 FORBIDDEN）
		 */
		function on (handler) {
			if (typeof handler !== 'function') return noop
			handlers.push(handler)
			return function () {
				off(handler)
			}
		}

		/** 取消监听：off(handler) 取消指定；off() 取消全部 */
		function off (handler) {
			if (typeof handler !== 'function') {
				handlers = []
				return
			}
			handlers = handlers.filter(function (item) {
				return item !== handler
			})
		}

		/** 立即失败的 Promise（入参校验失败等），同样吞掉未捕获异常 */
		function rejectNow (code, message) {
			var promise = Promise.reject(makeError(code, message))
			promise.catch(noop)
			return promise
		}

		/**
		 * 未握手时把消息排进出站队列。
		 * 场景：用户进页面就点「智能分析」，此时 iframe 往往还没加载完，直接发就丢了。
		 * 排队后等 $ready 到达自动回放，业务代码不必自己管时序。
		 */
		function enqueueOutbound (type, payload, wait) {
			return new Promise(function (resolve, reject) {
				var limit = maxPayloadSize()
				var size = limitEnabled(limit) ? measure(type, payload) : 0
				if (tooLarge(limit, size)) {
					reject(makeError(ERR.PAYLOAD_TOO_LARGE, '载荷体量超限（' + size + ' > ' + limit + ' 字符），已拦截：' + type))
					return
				}
				// size 一路带到回放：同一条消息不重复量体量（大载荷上量一次就是一趟全遍历）
				var item = { type: type, payload: payload, wait: wait, size: size, resolve: resolve, reject: reject }
				outbox.push(item)
				item.timer = setTimeout(function () {
					var index = outbox.indexOf(item)
					if (index > -1) outbox.splice(index, 1)
					reject(makeError(ERR.NOT_CONNECTED, '等待与子页握手超时（' + queueTimeout() + 'ms），消息已丢弃：' + type))
				}, queueTimeout())
				log('info', 'iframe-bridge(host): 尚未握手，已排队等待发送', { type: type, queued: outbox.length })
			})
		}

		/** 按入队顺序回放。必须严格 FIFO —— 分片类消息依赖顺序 */
		function flushOutbox () {
			var items = outbox.slice()
			outbox.length = 0
			items.forEach(function (item) {
				clearTimeout(item.timer)
				request(item.type, item.payload, item.wait, item.size).then(item.resolve, item.reject)
			})
		}

		/**
		 * 就绪回调：先回放队列，再通知订阅者。
		 * 顺序固定 —— 若先通知订阅者，业务回调里发的消息会插到历史队列之前，破坏 FIFO。
		 */
		function fireReady () {
			flushOutbox()
			readySinks.slice().forEach(function (cb) {
				try {
					cb()
				} catch (e) {
					log('error', 'iframe-bridge(host): onReady 回调异常', e)
				}
			})
		}

		/**
		 * 与子页握手完成时回调（注册时已就绪则立即执行）
		 * @returns {Function} 取消订阅
		 */
		function onReady (callback) {
			if (typeof callback !== 'function') {
				log('warn', 'iframe-bridge(host): onReady 需要传入函数，已忽略')
				return noop
			}
			if (ready) {
				try {
					callback()
				} catch (e) {
					log('error', 'iframe-bridge(host): onReady 回调异常', e)
				}
				return noop
			}
			readySinks.push(callback)
			return function () {
				readySinks = readySinks.filter(function (item) {
					return item !== callback
				})
			}
		}

		/**
		 * 内部触发（可发保留 type）；对外 emit 校验后也走这里
		 * @param {number} [knownSize] 上游已经量好的体量；传了就不再重复量
		 */
		function request (type, payload, wait, knownSize) {
			var promise = new Promise(function (resolve, reject) {
				// 未绑定就没必要等
				if (!attached || !remote) {
					reject(makeError(ERR.NOT_CONNECTED, '通信桥未绑定：' + type))
					return
				}
				// 体量先量再发，避免大对象白跑一趟才被 send 丢掉。量一次后就沿链传下去
				var limit = maxPayloadSize()
				var size = limitEnabled(limit)
					? (typeof knownSize === 'number' ? knownSize : measure(type, payload))
					: 0
				if (tooLarge(limit, size)) {
					reject(makeError(ERR.PAYLOAD_TOO_LARGE, '载荷体量超限（' + size + ' > ' + limit + ' 字符），已拦截：' + type))
					return
				}
				var id = nextId('p')
				var timer = setTimeout(function () {
					delete pending[id]
					reject(makeError(ERR.TIMEOUT, '子页未在超时时间内应答：' + type))
				}, pickNumber(wait, pickNumber(options.timeout, DEFAULTS.timeout)))
				pending[id] = { resolve: resolve, reject: reject, timer: timer }
				var sent = send({ kind: 'req', type: type, id: id, payload: payload }, size)
				if (!sent) {
					clearTimeout(timer)
					delete pending[id]
					reject(makeError(ERR.NOT_CONNECTED, '消息发送失败：' + type))
				}
			})
			// 允许调用方把 emit 当通知用（不 await）而不产生未捕获异常
			promise.catch(noop)
			return promise
		}

		/**
		 * 触发子页，返回 Promise
		 * - await  → 拿到子页监听函数的返回值
		 * - 不 await → 只是不等结果（协议层仍是一问一答），不会产生 unhandledrejection
		 * - 子页没注册监听 → resolve(undefined)，并记一条日志，不报错
		 * - 子页监听函数抛错 → reject，error.code 为子页给出的错误码
		 * - 还没握手（含尚未 attach） → 消息**排队**，握手一到按原序发出；不丢也不立刻失败
		 * @param {number} [wait] 本条的等待超时（ms），覆盖 host({ timeout })
		 *   emit('ai:ask', p)          用默认 4s
		 *   emit('ai:ask', p, 8000)   本条给 8s（受理慢的接口按次放宽）
		 */
		function emit (type, payload, wait) {
			if (typeof type !== 'string' || !type) {
				return rejectNow(ERR.INVALID_ARGUMENT, 'emit 的第一个参数必须是非空字符串：消息 type')
			}
			if (isReserved(type)) {
				return rejectNow(ERR.INVALID_ARGUMENT, 'emit 的 type 不能以 $ 开头（$ 是保留前缀）：' + type)
			}
			// 还没握手（含尚未 attach）：先排队，等子页 $ready 到达后按序回放。
			// 只有对外 emit 走这条 —— 内部 $init 应答必须直发，否则会把自己排死。
			if (!ready) {
				var queued = enqueueOutbound(type, payload, wait)
				queued.catch(noop)
				return queued
			}
			return request(type, payload, wait)
		}

		/** 是否允许向该 origin 下发令牌 */
		function canShareToken (origin) {
			var policy = options.allowToken
			var target = normalizeOrigin(origin)
			if (policy === true) return allowedOrigins.indexOf(target) > -1
			if (policy === 'same-origin') return isSameOrigin(target)
			if (Object.prototype.toString.call(policy) === '[object Array]') {
				return policy.map(normalizeOrigin).indexOf(target) > -1
			}
			return false
		}

		// -------------------------------------------------------- 内部实现

		function onMessage (event) {
			receive(event)
		}

		/** @param {number} [knownSize] 上游量好的体量；不传才自己量（量一次就是一趟全遍历） */
		function send (partial, knownSize) {
			if (!attached || !remote || !targetOrigin || targetOrigin === '*') return false
			var message = {
				ch: CHANNEL,
				v: VERSION,
				kind: partial.kind,
				type: partial.type,
				ts: Date.now()
			}
			if (partial.id) message.id = partial.id
			if (typeof partial.ok === 'boolean') message.ok = partial.ok
			if (partial.nh) message.nh = true
			if (typeof partial.payload !== 'undefined') message.payload = partial.payload
			if (partial.error) message.error = partial.error

			// 关掉上限时连量都不用量 —— 这是「maxPayloadSize: 0」最实际的收益
			var limit = maxPayloadSize()
			if (limitEnabled(limit)) {
				var size = typeof knownSize === 'number' ? knownSize : safeStringify(message).length
				if (size > limit) {
					log('warn', 'iframe-bridge(host): 出站消息体量超限，已丢弃', { type: partial.type, size: size })
					return false
				}
			}
			try {
				remote.postMessage(message, targetOrigin)
				return true
			} catch (e) {
				log('error', 'iframe-bridge(host): postMessage 失败', e)
				return false
			}
		}

		/** 入站消息总入口：任一校验不通过即静默丢弃 */
		function receive (event) {
			var message = event && event.data
			// 1) 频道 + 结构 + 版本
			if (!isObject(message) || message.ch !== CHANNEL) return
			if (message.v !== VERSION) {
				log('warn', 'iframe-bridge(host): 协议版本不匹配，已忽略', { got: message.v, expect: VERSION })
				return
			}
			if (!message.kind || typeof message.type !== 'string') return
			// 2) 来源窗口必须是绑定的那个 iframe，避免同页其它 iframe / 上层窗口伪造
			if (!remote || event.source !== remote) return
			// 3) 来源 origin 必须在白名单内
			var origin = normalizeOrigin(event.origin)
			if (allowedOrigins.indexOf(origin) === -1) {
				log('warn', 'iframe-bridge(host): 来源 origin 不在白名单，已忽略', { origin: origin, allowed: allowedOrigins })
				return
			}
			// 4) 体量粗筛（字符串类载荷零成本直接量；对象类由白名单来源 + 出站校验共同保证）
			var inboundLimit = maxPayloadSize()
			if (limitEnabled(inboundLimit) && typeof message.payload === 'string' && message.payload.length > inboundLimit) {
				log('warn', 'iframe-bridge(host): 入站消息体量超限，已忽略', { size: message.payload.length })
				return
			}

			if (message.kind === 'res') {
				handleResponse(message)
				return
			}

			// 保留 type：内部消化，不进监听函数
			if (isReserved(message.type)) {
				handleReserved(message, origin)
				return
			}

			if (message.kind === 'req') handleRequest(message)
			else runHandlers(buildPacket(message), false)
		}

		/** 保留 type 的内部处理：握手 / 高度上报 */
		function handleReserved (message, origin) {
			if (message.type === RESERVED.READY) {
				var firstReady = !ready
				ready = true
				// 每次 $ready 都回 $init，兼容子页脚本晚于 load 执行、以及子页内部重试
				sendInit()
				// 先应答 $init（让子页先标记已连接），再回放排队消息 ——
				// 否则子页回执时还没锁定父源，会退回用 '*' 出站
				if (firstReady) fireReady()
				// 握手后自动同步一次完整上下文，子页不用主动来要
				if (options.autoContextChange !== false) emit('contextChange', buildContext())
				return
			}
			if (message.type === RESERVED.HEIGHT) {
				var height = Number(message.payload && message.payload.height)
				if (!height || height < 0) return
				if (typeof options.onHeight === 'function') {
					try {
						options.onHeight(height)
					} catch (e) {
						log('error', 'iframe-bridge(host): onHeight 回调异常', e)
					}
				}
				return
			}
			// $init 只应出现在出站方向，入站直接忽略
			log('warn', 'iframe-bridge(host): 收到未知的保留 type，已忽略', { type: message.type, origin: origin })
		}

		/** 下发握手应答（子页 $ready 后） */
		function sendInit () {
			request(RESERVED.INIT, {
				protocolVersion: VERSION,
				// 子页收到父源后应把自己的出站 targetOrigin 锁定到该值
				parentOrigin: pageOrigin(),
				context: buildContext()
			})
		}

		function buildContext () {
			try {
				return (typeof options.getContext === 'function' && options.getContext()) || {}
			} catch (e) {
				log('error', 'iframe-bridge(host): getContext 取值异常', e)
				return {}
			}
		}

		/** 子页请求（emit）：跑监听函数并回执 */
		function handleRequest (message) {
			if (!handlers.length) {
				// 一条监听都没注册：回一条「无处理者」回执（不带 payload），子页侧 resolve(undefined)
				send({ kind: 'res', type: message.type, id: message.id, ok: true, nh: true })
				return
			}
			runHandlers(buildPacket(message, origin), true).then(
				function (result) {
					// 返回 undefined（没处理这个 type / 压根没返回值）→ 不带 payload 并标记 nh
					var handled = typeof result !== 'undefined'
					send({ kind: 'res', type: message.type, id: message.id, ok: true, nh: !handled, payload: handled ? result : undefined })
				},
				function (e) {
					log('error', 'iframe-bridge(host): 监听函数异常 ' + message.type, e)
					// 监听函数抛出的异常若带 code（如 FORBIDDEN）则原样回给子页，否则归为 INTERNAL
					var code = (e && e.code) || ERR.INTERNAL
					send({
						kind: 'res',
						type: message.type,
						id: message.id,
						ok: false,
						error: makeError(code, (e && e.message) || '父应用处理异常')
					})
				}
			)
		}

		/** 组装交给监听函数的消息包：只给 type + payload，其余是协议内部字段 */
		function buildPacket (message) {
			return {
				type: message.type,
				payload: message.payload
			}
		}

		/**
		 * 按顺序执行监听函数
		 * @param {boolean} wantResult 需要回执时取第一个非 undefined 的返回值；有异常则抛给子页
		 */
		function runHandlers (packet, wantResult) {
			var list = handlers.slice()
			var result
			var failure
			var chain = Promise.resolve()
			list.forEach(function (handler) {
				chain = chain.then(function () {
					return Promise.resolve()
						.then(function () {
							return handler(packet)
						})
						.then(function (value) {
							if (typeof result === 'undefined' && typeof value !== 'undefined') result = value
						})
						.catch(function (e) {
							if (typeof failure === 'undefined') failure = e
							log('error', 'iframe-bridge(host): 监听函数异常 ' + packet.type, e)
						})
				})
			})
			return chain.then(function () {
				if (wantResult) {
					if (typeof failure !== 'undefined') throw failure
					return result
				}
				return undefined
			})
		}

		function handleResponse (message) {
			if (!message.id) return
			var item = pending[message.id]
			if (!item) return
			delete pending[message.id]
			clearTimeout(item.timer)
			if (!message.ok) {
				item.reject(message.error || makeError(ERR.INTERNAL, '子页应答失败'))
				return
			}
			if (message.nh) log('warn', 'iframe-bridge(host): 子页未处理该 type，本次触发无处理者：' + message.type)
			item.resolve(message.payload)
		}

		var api = {
			version: VERSION,
			channel: CHANNEL,
			reserved: RESERVED,

			/** 监听：on(handler) → 取消监听的函数 */
			on: on,
			/** 取消监听：off(handler) 取消指定；off() 取消全部 */
			off: off,
			/** 触发子页：emit(type, payload) → Promise */
			emit: emit,

			/** 绑定 / 换绑对端 window */
			attach: attach,
			/** 解绑（拒绝所有挂起请求） */
			detach: detach,
			/** 页面销毁时调用 */
			destroy: destroy,

			/** 是否已握手完成 */
			isReady: isReady,
			/** 与子页握手完成时回调：onReady(cb) → 取消订阅（注册时已就绪则立即执行） */
			onReady: onReady,
			/** 当前绑定的对端 origin */
			getTargetOrigin: getTargetOrigin,
			/** 是否允许向该 origin 下发令牌 */
			canShareToken: canShareToken
		}

		// 创建时就把对端一起给出也是常见写法（少一次 attach 调用）
		if (options.remote && options.targetOrigin) attach(options.remote, options.targetOrigin)

		return api
	}

	// ============================================================ 导出

	var bridge = createPageSide({
		self: global,
		parent: global.parent,
		referrer: global.document && global.document.referrer,
		logger: function (level, message, detail) {
			var method = level === 'info' ? 'log' : level
			if (global.console && global.console[method]) {
				global.console[method]('[iframe-bridge]', message, detail || '')
			}
		}
	})

	/** 父应用侧：建一个绑定某 iframe 的桥。子页不需要它。 */
	bridge.host = createHostSide
	/** 由目标地址算出确切 origin（父应用侧算 iframe.src 用） */
	bridge.resolveOrigin = resolveOrigin
	/** 仅测试使用：注入自定义环境建一个子页侧桥 */
	bridge.create = createPageSide
	/** 常量（排查 / 业务对齐用） */
	bridge.VERSION = VERSION
	bridge.CHANNEL = CHANNEL
	bridge.RESERVED = RESERVED
	bridge.ERR = ERR

	global.ScIframeBridge = bridge
})(typeof window !== 'undefined' ? window : this)
