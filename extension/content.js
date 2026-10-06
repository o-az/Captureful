;(() => {
  if (globalThis.__scrollingScreenshotLoaded) return
  globalThis.__scrollingScreenshotLoaded = true

  /**
   * @typedef {{ confirmArea: boolean, autoStop: boolean, scale: number }} Settings
   * @typedef {[number, number]} Interval
   * @typedef {{ y: number, height: number, blob: Blob }} Piece
   * @typedef {{ el: Element, top: number }} Anchor
   * @typedef {{ key: string, offsetX: number, offsetY: number, sx: number, sy: number, clearTop: number, clearBottom: number }} Calibration
   * @typedef {'idle' | 'armed' | 'confirm' | 'pick' | 'capturing' | 'processing' | 'result'} State
   * @typedef {{ blob: Blob, url: string, width: number, height: number }} Part
   */

  const SHADOW_SEP = ' >>> '
  const MAX_CANVAS_AREA = 16_777_216
  const MAX_CANVAS_SIDE = 16_384
  const MAX_PDF_PAGE_PT = 14_400
  const IDLE_CAPTURE_MS = 140
  const AUTO_STOP_MS = 3000
  const AUTO_SCROLL_STEP = 0.8
  const CAPTURE_TIMEOUT_MS = 4000
  /** Max CSS px a manual scroll may move during a shot for it to be kept. */
  const MAX_SHOT_DRIFT = 24
  /** Max CSS px a frame's tracked position is corrected by pixel matching. */
  const MAX_ALIGN_SHIFT = 48
  const SIGNATURE_COLUMNS = 32
  /** Overlays this close to the band's edge (e.g. a date pill under a header) are trimmed too. */
  const EDGE_SLACK = 12
  /** @type {Settings} */
  const DEFAULT_SETTINGS = { confirmArea: false, autoStop: true, scale: 0 }

  /* --------------------------------- storage ---------------------------------- */

  /** @type {Settings} */
  let settings = { ...DEFAULT_SETTINGS }
  /** @type {Record<string, string>} */
  let areas = {}

  const loadStorage = async () => {
    try {
      const stored = await browser.storage.local.get(['settings', 'areas'])
      settings = { ...DEFAULT_SETTINGS, ...stored.settings }
      areas = stored.areas ?? {}
    } catch (error) {
      console.warn('[scrolling-screenshot] storage unavailable', error)
    }
  }

  /** @param {string | null} selector */
  const saveArea = (selector) => {
    if (selector) areas[location.host] = selector
    else delete areas[location.host]
    void browser.storage.local.set({ areas })
  }

  /* ------------------------------ scroll targets ------------------------------ */

  const scrollingElement = () =>
    document.scrollingElement || document.documentElement

  /** @param {Element} el */
  const isDocumentTarget = (el) =>
    el === scrollingElement() ||
    el === document.documentElement ||
    el === document.body

  /**
   * Parent element, stepping out of shadow roots to their host.
   * @param {Element} el
   * @returns {Element | null}
   */
  const parentOf = (el) =>
    el.parentElement ||
    (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null)

  /** @param {Element} el */
  const isOwnUi = (el) => el === ui?.host || el === calibrationMarker

  /**
   * Every element in the document, including inside open shadow roots.
   * @param {Document | ShadowRoot} [root]
   * @returns {Element[]}
   */
  const allElements = (root = document) => {
    /** @type {Element[]} */
    const out = []
    for (const el of root.querySelectorAll('*')) {
      if (isOwnUi(el)) continue
      out.push(el)
      if (el.shadowRoot) out.push(...allElements(el.shadowRoot))
    }
    return out
  }

  /**
   * elementsFromPoint that also looks inside open shadow roots (innermost first).
   * @param {number} x @param {number} y @param {Document | ShadowRoot} [root]
   * @returns {Element[]}
   */
  const elementsAt = (x, y, root = document) => {
    /** @type {Element[]} */
    const out = []
    for (const el of root.elementsFromPoint(x, y)) {
      if (isOwnUi(el) || out.includes(el)) continue
      if (el.shadowRoot && el.shadowRoot !== root) {
        for (const inner of elementsAt(x, y, el.shadowRoot)) {
          if (!out.includes(inner)) out.push(inner)
        }
      }
      if (!out.includes(el)) out.push(el)
    }
    return out
  }

  /** @param {Element} el */
  const isScrollableY = (el) => {
    if (isDocumentTarget(el)) {
      return scrollingElement().scrollHeight > window.innerHeight + 1
    }
    const { overflowY } = getComputedStyle(el)
    return (
      /(auto|scroll|overlay)/.test(overflowY) &&
      el.scrollHeight > el.clientHeight + 1
    )
  }

  /**
   * @param {EventTarget | Node | null} node
   * @returns {Element | null}
   */
  const resolveScrollTarget = (node) => {
    let el = node instanceof Element ? node : null
    while (el) {
      if (isDocumentTarget(el)) break
      if (isScrollableY(el)) return el
      el = parentOf(el)
    }
    return isScrollableY(scrollingElement()) ? scrollingElement() : null
  }

  /** @param {Element} el */
  const nextScrollableAncestor = (el) => {
    if (isDocumentTarget(el)) return null
    const parent = parentOf(el)
    return parent ? resolveScrollTarget(parent) : null
  }

  /** @param {Element} el */
  const getScrollTop = (el) =>
    isDocumentTarget(el) ? window.scrollY : el.scrollTop

  /** @param {Element} el @param {number} top */
  const setScrollTop = (el, top) => {
    // iOS Safari reports an unclamped window.scrollY after scrolling past the end.
    const [min, max] = scrollRange(el)
    const clamped = Math.min(max, Math.max(min, top))
    // Chat UIs that stick to the bottom undo scrolls not preceded by user input.
    const delta = clamped - getScrollTop(el)
    const wheelTarget = isDocumentTarget(el) ? document.documentElement : el
    wheelTarget.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: delta,
        bubbles: true,
        cancelable: true,
      }),
    )
    if (isDocumentTarget(el))
      window.scrollTo({ top: clamped, behavior: 'instant' })
    else el.scrollTo({ top: clamped, behavior: 'instant' })
  }

  /** @param {Element} el @returns {[number, number]} */
  const scrollRange = (el) => {
    if (isDocumentTarget(el)) {
      return [
        0,
        Math.max(0, scrollingElement().scrollHeight - window.innerHeight),
      ]
    }
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    // flex column-reverse containers scroll from 0 (bottom) to -max (top).
    return getComputedStyle(el).flexDirection === 'column-reverse'
      ? [-max, 0]
      : [0, max]
  }

  /**
   * Client box of the scroll target in viewport coordinates.
   * @param {Element} el
   */
  const viewportOf = (el) => {
    if (isDocumentTarget(el)) {
      const width = document.documentElement.clientWidth
      const height = window.innerHeight
      return { top: 0, left: 0, width, height, bottom: height, right: width }
    }
    const rect = el.getBoundingClientRect()
    const top = rect.top + el.clientTop
    const left = rect.left + el.clientLeft
    return {
      top,
      left,
      width: el.clientWidth,
      height: el.clientHeight,
      bottom: top + el.clientHeight,
      right: left + el.clientWidth,
    }
  }

  /** The part of the target's client box that is on screen. @param {Element} el */
  const visibleBoxOf = (el) => {
    const vp = viewportOf(el)
    const top = Math.max(vp.top, 0)
    const left = Math.max(vp.left, 0)
    const bottom = Math.min(vp.bottom, window.innerHeight)
    const right = Math.min(vp.right, document.documentElement.clientWidth)
    return { vp, top, left, bottom, right }
  }

  /** @param {Element} ancestor @param {Element} el */
  const containsComposed = (ancestor, el) => {
    for (
      let node = /** @type {Element | null} */ (el);
      node;
      node = parentOf(node)
    )
      if (node === ancestor) return true
    return false
  }

  /**
   * Pinned elements (headers, composers) paint over the target's content, so
   * frames only keep the band between them: sticky/fixed ones, and absolutely
   * positioned overlays outside the scroller (they don't move with its content).
   * @param {Element} el @param {ReturnType<typeof visibleBoxOf>} box
   */
  const unobstructedBoxOf = (el, box) => {
    const width = box.right - box.left
    const height = box.bottom - box.top
    const isDoc = isDocumentTarget(el)
    /** @type {DOMRect[]} */
    const pinned = []
    for (const node of allElements()) {
      if (node === el || !(node instanceof HTMLElement)) continue
      const position = getComputedStyle(node).position
      const inside = !isDoc && containsComposed(el, node)
      if (position === 'absolute') {
        if (isDoc || inside || containsComposed(node, el)) continue
      } else if (position === 'sticky') {
        if (!inside && !isDoc) continue
      } else if (position !== 'fixed') continue
      const rect = node.getBoundingClientRect()
      const overlap =
        Math.min(rect.right, box.right) - Math.max(rect.left, box.left)
      if (overlap < width * 0.5 || rect.height < 1) continue
      if (rect.height > height * 0.5) continue
      if (rect.bottom <= box.top || rect.top >= box.bottom) continue
      if (position === 'sticky') {
        const previous = node.style.position
        node.style.position = 'static'
        const natural = node.getBoundingClientRect()
        node.style.position = previous
        if (Math.abs(natural.top - rect.top) < 1) continue
      }
      pinned.push(rect)
    }
    let { top, bottom } = box
    // Stacked overlays (header, then a fade below it) trim the band in turn.
    for (let changed = true; changed; ) {
      changed = false
      for (const rect of pinned) {
        if (rect.bottom <= top || rect.top >= bottom) continue
        if (rect.top <= top + EDGE_SLACK) top = rect.bottom
        else if (rect.bottom >= bottom - EDGE_SLACK) bottom = rect.top
        else continue
        changed = true
      }
    }
    if (bottom - top < height * 0.2) return box
    return { ...box, top, bottom }
  }

  /**
   * Small floating controls over the content (e.g. "jump to bottom" buttons) that
   * aren't part of the scroller; hidden during each shot so they don't repeat.
   * @param {Element} el @param {ReturnType<typeof visibleBoxOf>} box
   * @returns {HTMLElement[]}
   */
  const floatingOverlaysOf = (el, box) => {
    if (isDocumentTarget(el)) return []
    const width = box.right - box.left
    const height = box.bottom - box.top
    /** @type {HTMLElement[]} */
    const found = []
    for (const node of allElements()) {
      if (!(node instanceof HTMLElement)) continue
      const position = getComputedStyle(node).position
      if (position !== 'absolute' && position !== 'fixed') continue
      if (containsComposed(el, node) || containsComposed(node, el)) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      if (rect.width >= width * 0.5 || rect.height >= height * 0.5) continue
      if (
        rect.right <= box.left ||
        rect.left >= box.right ||
        rect.bottom <= box.top ||
        rect.top >= box.bottom
      )
        continue
      if (found.some((outer) => outer.contains(node))) continue
      found.push(node)
    }
    return found
  }

  /** @param {Element} el */
  const backgroundOf = (el) => {
    /** @type {Element | null} */
    let node = el
    while (node) {
      const color = getComputedStyle(node).backgroundColor
      if (color && color !== 'transparent' && !color.endsWith(', 0)'))
        return color
      node = parentOf(node)
    }
    return '#ffffff'
  }

  /** @param {Element} el */
  const selectorFor = (el) => {
    if (isDocumentTarget(el)) return ':root'
    // One selector per tree, outermost first, joined by SHADOW_SEP for open shadow roots.
    /** @type {string[]} */
    const trees = []
    /** @type {string[]} */
    let parts = []
    /** @type {Element | null} */
    let node = el
    while (node && node !== document.documentElement) {
      const root = node.getRootNode()
      const scope = root instanceof ShadowRoot ? root : document
      const current = node
      if (
        node.id &&
        scope.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1
      ) {
        parts.unshift(`#${CSS.escape(node.id)}`)
      } else {
        let part = node.localName
        const testId = node.getAttribute('data-testid')
        if (testId) part += `[data-testid="${CSS.escape(testId)}"]`
        const siblings = Array.from(
          node.parentElement?.children ?? scope.children,
        ).filter((child) => child.localName === current.localName)
        if (siblings.length > 1)
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        parts.unshift(part)
        if (node.parentElement) {
          node = node.parentElement
          continue
        }
      }
      trees.unshift(parts.join(' > '))
      parts = []
      node = root instanceof ShadowRoot ? root.host : null
    }
    if (parts.length) trees.unshift(parts.join(' > '))
    return trees.join(SHADOW_SEP)
  }

  const rememberedTarget = () => {
    const selector = areas[location.host]
    if (!selector) return null
    try {
      const el =
        selector === ':root'
          ? scrollingElement()
          : selector
              .split(SHADOW_SEP)
              .reduce(
                (/** @type {Element | null} */ found, part, index) =>
                  index === 0
                    ? document.querySelector(part)
                    : (found?.shadowRoot?.querySelector(part) ?? null),
                null,
              )
      return el && isScrollableY(el) ? el : null
    } catch {
      return null
    }
  }

  /** @param {Element} el */
  const paintsBackground = (el) => {
    const style = getComputedStyle(el)
    const alpha = style.backgroundColor.match(/[\d.]+/g)?.[3]
    return (
      (style.backgroundColor !== 'transparent' && alpha !== '0') ||
      style.backgroundImage !== 'none' ||
      (style.backdropFilter || 'none') !== 'none'
    )
  }

  /**
   * The innermost scrollable area at a point. Sites often put the visible content of
   * a scroller in a sibling layer on top of it, so the elements under the point
   * aren't always inside the scroller; fall back to geometry.
   * @param {number} x @param {number} y
   */
  const scrollableAt = (x, y) => {
    for (const hit of elementsAt(x, y)) {
      const found = resolveScrollTarget(hit)
      if (found && !isDocumentTarget(found)) return found
      // Only see through layers that don't paint over what's beneath (e.g. not modals).
      if (paintsBackground(hit)) return found
    }
    /** @type {Element | null} */
    let best = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const el of allElements()) {
      const rect = el.getBoundingClientRect()
      const area = rect.width * rect.height
      if (
        area >= bestArea ||
        x < rect.left ||
        x > rect.right ||
        y < rect.top ||
        y > rect.bottom ||
        !isScrollableY(el)
      )
        continue
      best = el
      bestArea = area
    }
    if (best) return best
    return isScrollableY(scrollingElement()) ? scrollingElement() : null
  }

  /* ------------------------------------ ui ------------------------------------ */

  const STYLES = /* css */ `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483647;
    }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .highlight {
      position: fixed;
      pointer-events: none;
      z-index: 1;
      border: 2px solid #2563eb;
      border-radius: 2px;
      display: none;
    }
    .highlight[data-mode='tint'] { background: rgba(37, 99, 235, 0.2); }
    .highlight[data-mode='outline'] { border-style: dashed; border-color: rgba(239, 68, 68, 0.8); }
    .catcher {
      position: fixed;
      inset: 0;
      z-index: 2;
      cursor: crosshair;
      display: none;
      background: rgba(0, 0, 0, 0.05);
    }
    .pill, .sheet {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
      z-index: 3;
      max-width: calc(100vw - 16px);
      background: rgba(17, 17, 17, 0.94);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      font-size: 14px;
      line-height: 1.3;
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 8px 8px 12px;
      white-space: nowrap;
    }
    .pill[hidden], .sheet[hidden], .result[hidden], .toast[hidden] { display: none; }
    .sheet { width: min(420px, calc(100vw - 16px)); padding: 14px; }
    .sheet p { margin: 0 0 4px; font-weight: 600; }
    .sheet small { display: block; opacity: 0.7; margin-bottom: 12px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; }
    .label { overflow: hidden; text-overflow: ellipsis; }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      flex: none;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .dot[data-idle] { background: #a3a3a3; animation: none; }
    .warn { color: #fbbf24; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    button {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: inherit;
      font: inherit;
      font-size: 13px;
      border-radius: 4px;
      padding: 7px 10px;
      cursor: pointer;
      touch-action: manipulation;
    }
    button:active { background: rgba(255, 255, 255, 0.2); }
    button[data-primary] { background: #2563eb; border-color: #2563eb; }
    button[data-danger] { background: #dc2626; border-color: #dc2626; }
    button:disabled { opacity: 0.4; }
    .result {
      position: fixed;
      inset: 0;
      z-index: 4;
      display: flex;
      flex-direction: column;
      background: #0a0a0a;
      color: #fff;
      padding-top: env(safe-area-inset-top, 0px);
    }
    .result header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 12px;
      max-height: 40vh;
      overflow-y: auto;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    .result header .label { flex: 1 1 100%; font-size: 13px; opacity: 0.8; }
    .result .images {
      flex: 1;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .result img { max-width: min(100%, 720px); height: auto; border: 1px solid rgba(255, 255, 255, 0.15); }
    .toast {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      top: calc(env(safe-area-inset-top, 0px) + 12px);
      z-index: 5;
      background: rgba(17, 17, 17, 0.94);
      color: #fff;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      max-width: calc(100vw - 24px);
    }
  `

  /** @type {{ host: HTMLElement, root: ShadowRoot, highlight: HTMLElement, catcher: HTMLElement, pill: HTMLElement, sheet: HTMLElement, result: HTMLElement, toast: HTMLElement } | null} */
  let ui = null
  /** @type {HTMLElement | null} */
  let calibrationMarker = null

  const ensureUi = () => {
    if (ui?.host.isConnected) return ui
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = /* html */ `
      <style>${STYLES}</style>
      <div class="highlight"></div>
      <div class="catcher"></div>
      <div class="pill" hidden></div>
      <div class="sheet" hidden></div>
      <div class="result" hidden></div>
      <div class="toast" hidden></div>
    `
    document.documentElement.append(host)
    /** @param {string} selector */
    const part = (selector) => {
      const el = root.querySelector(selector)
      if (!(el instanceof HTMLElement)) throw new Error(`missing ${selector}`)
      return el
    }
    ui = {
      host,
      root,
      highlight: part('.highlight'),
      catcher: part('.catcher'),
      pill: part('.pill'),
      sheet: part('.sheet'),
      result: part('.result'),
      toast: part('.toast'),
    }
    root.addEventListener('click', onUiClick)
    ui.catcher.addEventListener('click', onCatcherClick)
    return ui
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer
  /** @param {string} message */
  const toast = (message) => {
    const { toast: el } = ensureUi()
    el.textContent = message
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.hidden = true
    }, 2600)
  }

  /** @param {string} str */
  const escapeHtml = (str) =>
    str.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

  /** @param {number} px */
  const formatPx = (px) => `${Math.round(px).toLocaleString()} px`

  /* --------------------------------- session ---------------------------------- */

  /** @type {State} */
  let state = 'idle'
  /** @type {Element | null} */
  let target = null
  /** @type {Element | null} */
  let candidate = null
  /** @type {Element[]} */
  let pickStack = []
  /** @type {Piece[]} */
  let pieces = []
  /** @type {Interval[]} */
  let coverage = []
  /** @type {Anchor[]} */
  let anchors = []
  let frameCount = 0
  let position = 0
  let lastScrollTop = 0
  /** @type {Promise<void> | null} */
  let inflight = null
  let pendingCapture = false
  let finishing = false
  /** @type {0 | 1 | -1} */
  let autoDirection = 0
  /** @type {0 | 1 | -1} */
  let travelDirection = 0
  let captureErrors = 0
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let edgeTimer
  let updateRaf = 0
  let highlightRaf = 0
  /** @type {MutationObserver | null} */
  let observer = null
  /** @type {Calibration | null} */
  let calibration = null
  /** Row signature of the last accepted frame, for aligning the next one. @type {{ range: Interval, rows: Uint8ClampedArray } | null} */
  let lastSignature = null
  /** @type {Part[]} */
  let parts = []
  let resultInfo = ''
  let resultStem = ''
  /** Output pixels per CSS pixel, locked when capturing starts. */
  let sessionScale = 0
  let frameWidthCss = 0
  /** Bumped on reset so stale async work (capture, stitching, auto-scroll) can bail. */
  let generation = 0
  let autoRun = 0

  /** @type {Array<Document | ShadowRoot>} */
  let scrollRoots = []

  // Scroll events don't cross shadow boundaries, so listen on each open shadow root too.
  const listenScroll = () => {
    unlistenScroll()
    scrollRoots = [document]
    for (const el of allElements())
      if (el.shadowRoot) scrollRoots.push(el.shadowRoot)
    for (const root of scrollRoots) {
      root.addEventListener('scroll', onScroll, {
        capture: true,
        passive: true,
      })
    }
  }

  const unlistenScroll = () => {
    for (const root of scrollRoots) {
      root.removeEventListener('scroll', onScroll, true)
    }
    scrollRoots = []
  }

  const resetSession = () => {
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    cancelAnimationFrame(updateRaf)
    cancelAnimationFrame(highlightRaf)
    observer?.disconnect()
    observer = null
    unlistenScroll()
    document.removeEventListener('keydown', onKeydown, true)
    for (const part of parts) URL.revokeObjectURL(part.url)
    calibrationMarker?.remove()
    calibrationMarker = null
    if (ui) ui.host.style.visibility = ''
    target = null
    candidate = null
    pickStack = []
    pieces = []
    coverage = []
    anchors = []
    parts = []
    frameCount = 0
    position = 0
    lastScrollTop = 0
    inflight = null
    pendingCapture = false
    finishing = false
    autoDirection = 0
    travelDirection = 0
    captureErrors = 0
    updateRaf = 0
    highlightRaf = 0
    calibration = null
    lastSignature = null
    sessionScale = 0
    frameWidthCss = 0
    generation++
    autoRun++
  }

  /** @param {State} next */
  const setState = (next) => {
    state = next
    render()
  }

  let starting = false
  const start = async () => {
    if (state !== 'idle' || starting) return
    starting = true
    try {
      await loadStorage()
    } finally {
      starting = false
    }
    if (state !== 'idle') return
    ensureUi()
    resetSession()
    candidate = settings.confirmArea ? rememberedTarget() : null
    listenScroll()
    document.addEventListener('keydown', onKeydown, true)
    setState('armed')
    trackHighlight()
  }

  const cancel = () => {
    resetSession()
    setState('idle')
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape') return
    if (state === 'pick') {
      setState(candidate ? 'confirm' : 'armed')
      return
    }
    cancel()
  }

  /** @param {Event} event */
  function onScroll(event) {
    if (state === 'armed' || state === 'confirm') {
      const scrolled = resolveScrollTarget(event.target)
      if (!scrolled) return
      if (!settings.confirmArea) {
        beginCapture(scrolled)
        return
      }
      if (state === 'armed' && rememberedTarget() === scrolled) {
        beginCapture(scrolled)
        return
      }
      if (candidate !== scrolled || state !== 'confirm') {
        candidate = scrolled
        pickStack = []
        setState('confirm')
      }
      return
    }
    if (state !== 'capturing' || !target) return
    if (resolveScrollTarget(event.target) !== target) return
    scheduleUpdate()
  }

  /** @param {Element} el */
  const beginCapture = (el) => {
    target = el
    candidate = null
    lastScrollTop = getScrollTop(el)
    position = 0
    anchors = sampleAnchors()
    observer = new MutationObserver(() => {
      scheduleUpdate()
    })
    observer.observe(isDocumentTarget(el) ? document.body : el, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    setState('capturing')
    scheduleIdleCapture()
  }

  /* ---------------------------- position tracking ----------------------------- */

  /** @param {Element} el */
  const isPinned = (el) => {
    /** @type {Element | null} */
    let node = el
    while (node && node !== target) {
      const { position: pos } = getComputedStyle(node)
      if (pos === 'fixed' || pos === 'sticky') return true
      node = parentOf(node)
    }
    return false
  }

  /** @returns {Anchor[]} */
  const sampleAnchors = () => {
    if (!target) return []
    const { top, left, bottom, right } = visibleBoxOf(target)
    if (bottom - top < 4 || right - left < 4) return []
    const isDoc = isDocumentTarget(target)
    /** @type {Anchor[]} */
    const found = []
    const seen = new Set()
    for (const fx of [0.3, 0.7]) {
      for (const fy of [0.15, 0.5, 0.85]) {
        const x = left + (right - left) * fx
        const y = top + (bottom - top) * fy
        for (const el of elementsAt(x, y)) {
          if (el === target) continue
          if (
            isDoc
              ? el === document.documentElement || el === document.body
              : !target.contains(el)
          ) {
            continue
          }
          if (seen.has(el) || isPinned(el)) break
          seen.add(el)
          found.push({ el, top: el.getBoundingClientRect().top })
          break
        }
      }
    }
    return found
  }

  /** @param {number[]} values */
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  }

  /**
   * Tracks the target's viewport top in a coordinate space fixed to its content.
   * Visible elements are used as anchors so content inserted, recycled or resized
   * above the viewport (lazy loading, virtualized lists, late images) doesn't skew it.
   * The scrollTop delta is the fallback when no anchor survived.
   */
  const updatePosition = () => {
    const el = target
    if (!el) return
    const scrollTop = getScrollTop(el)
    let delta = scrollTop - lastScrollTop
    const isDoc = isDocumentTarget(el)
    const alive = anchors.filter(
      (anchor) => anchor.el.isConnected && (isDoc || el.contains(anchor.el)),
    )
    if (alive.length) {
      // When content reflows unevenly (rows inserted and regrouped), only the
      // anchor nearest the already-captured side keeps the seam aligned.
      const edge = travelDirection
        ? alive.reduce((best, anchor) =>
            (anchor.top - best.top) * travelDirection < 0 ? anchor : best,
          )
        : null
      delta = edge
        ? edge.top - edge.el.getBoundingClientRect().top
        : median(
            alive.map(
              (anchor) => anchor.top - anchor.el.getBoundingClientRect().top,
            ),
          )
    }
    if (Math.abs(delta) > 0.5) travelDirection = delta > 0 ? 1 : -1
    position += delta
    lastScrollTop = scrollTop
    anchors = sampleAnchors()
  }

  const scheduleUpdate = () => {
    if (updateRaf) return
    updateRaf = requestAnimationFrame(() => {
      updateRaf = 0
      updatePosition()
      if (!autoDirection && !finishing) {
        scheduleIdleCapture()
        scheduleEdgeStop()
        // Continuous scrolling postpones the idle shot; take one before a gap opens.
        const current = currentRange()
        if (current && coverage.length) {
          const band = current.range[1] - current.range[0]
          const missing = uncovered(current.range).reduce(
            (sum, [a, b]) => sum + (b - a),
            0,
          )
          if (missing > band * 0.4) void captureIfNeeded()
        }
      }
      renderPill()
    })
  }

  const scheduleIdleCapture = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void captureIfNeeded()
    }, IDLE_CAPTURE_MS)
  }

  const scheduleEdgeStop = () => {
    clearTimeout(edgeTimer)
    if (!settings.autoStop || !target || frameCount < 2 || !travelDirection)
      return
    const [min, max] = scrollRange(target)
    const scrollTop = getScrollTop(target)
    const atEdge =
      travelDirection > 0 ? scrollTop >= max - 1 : scrollTop <= min + 1
    if (!atEdge) return
    edgeTimer = setTimeout(() => {
      if (state === 'capturing' && !autoDirection) void finish()
    }, AUTO_STOP_MS)
  }

  /* --------------------------------- coverage --------------------------------- */

  /** @param {Interval[]} intervals @returns {Interval[]} */
  const mergeIntervals = (intervals) => {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0])
    /** @type {Interval[]} */
    const merged = []
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1]
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    return merged
  }

  /** @param {Interval} range @returns {Interval[]} */
  const uncovered = ([start, end]) => {
    /** @type {Interval[]} */
    const gaps = []
    let cursor = start
    for (const [cStart, cEnd] of coverage) {
      if (cEnd <= cursor) continue
      if (cStart >= end) break
      if (cStart > cursor) gaps.push([cursor, Math.min(cStart, end)])
      cursor = Math.max(cursor, cEnd)
      if (cursor >= end) break
    }
    if (cursor < end) gaps.push([cursor, end])
    return gaps.filter(([a, b]) => b - a >= 2)
  }

  /* --------------------------------- capture ---------------------------------- */

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(resolve))

  /**
   * @template T
   * @param {Promise<T>} promise @param {number} ms @param {string} what
   * @returns {Promise<T>}
   */
  const withTimeout = (promise, ms, what) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} timed out`)), ms),
      ),
    ])

  /** @param {number} width @param {number} height */
  const createCanvas = (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  /** @param {HTMLCanvasElement} canvas */
  const context2d = (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    return ctx
  }

  /** @param {HTMLCanvasElement} canvas @param {string} type @param {number} [quality] @returns {Promise<Blob>} */
  const canvasToBlob = (canvas, type, quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error('Canvas export failed')),
        type,
        quality,
      )
    })

  /** Screenshot of the visible tab with our own UI hidden. */
  /** @param {ReturnType<typeof visibleBoxOf>} [box] */
  const screenshot = async (box) => {
    const host = ui?.host
    if (host) host.style.visibility = 'hidden'
    const floating = target && box ? floatingOverlaysOf(target, box) : []
    const floatingVisibility = floating.map((node) => node.style.visibility)
    for (const node of floating) node.style.visibility = 'hidden'
    // Restyling the root scroller makes iOS Safari restore an older page scroll position.
    const scroller =
      target instanceof HTMLElement && !isDocumentTarget(target) ? target : null
    const scrollbarWidth = scroller?.style.scrollbarWidth ?? ''
    if (scroller) scroller.style.scrollbarWidth = 'none'
    try {
      await nextFrame()
      await nextFrame()
      const response = await withTimeout(
        browser.runtime.sendMessage({ type: 'capture' }),
        CAPTURE_TIMEOUT_MS,
        'Screenshot',
      )
      if (!response?.ok) throw new Error(response?.error || 'Screenshot failed')
      const blob = await (await fetch(response.url)).blob()
      return await createImageBitmap(blob)
    } finally {
      floating.forEach((node, i) => {
        node.style.visibility = floatingVisibility[i] ?? ''
      })
      if (scroller) scroller.style.scrollbarWidth = scrollbarWidth
      if (host && state !== 'idle') host.style.visibility = ''
    }
  }

  const viewportKey = () =>
    [
      window.innerWidth,
      window.innerHeight,
      window.visualViewport?.scale ?? 1,
      window.visualViewport?.offsetTop ?? 0,
    ].join(',')

  /**
   * Screenshots cover the whole screen (status bar and browser chrome included), so
   * a full-height stripe is painted at the viewport's left edge and located in a
   * screenshot to map viewport coordinates to screenshot pixels.
   * @returns {Promise<Calibration>}
   */
  const calibrate = async () => {
    const key = viewportKey()
    const marker = document.createElement('div')
    marker.style.cssText = `all:initial;position:fixed;left:0;top:0;width:6px;height:${window.innerHeight}px;background:#ff00ff;z-index:2147483647;pointer-events:none`
    calibrationMarker = marker
    document.documentElement.append(marker)
    /** @type {ImageBitmap} */
    let bitmap
    try {
      bitmap = await screenshot()
    } finally {
      marker.remove()
      calibrationMarker = null
    }
    const sx = bitmap.width / document.documentElement.clientWidth
    const canvas = createCanvas(1, bitmap.height)
    const ctx = context2d(canvas)
    ctx.drawImage(
      bitmap,
      Math.floor(sx * 3),
      0,
      1,
      bitmap.height,
      0,
      0,
      1,
      bitmap.height,
    )
    const data = ctx.getImageData(0, 0, 1, bitmap.height).data
    let first = -1
    let last = -1
    // Rows where Safari's own bars fade over the page aren't pure magenta.
    let pureFirst = -1
    let pureLast = -1
    for (let y = 0; y < bitmap.height; y++) {
      const r = data[y * 4] ?? 0
      const g = data[y * 4 + 1] ?? 0
      const b = data[y * 4 + 2] ?? 0
      if (r > 200 && g < 90 && b > 200) {
        if (first < 0) first = y
        last = y
      }
      if (r >= 250 && g <= 5 && b >= 250) {
        if (pureFirst < 0) pureFirst = y
        pureLast = y
      }
    }
    bitmap.close()
    if (first < 0) {
      console.warn('[scrolling-screenshot] calibration marker not found')
      return {
        key,
        offsetX: 0,
        offsetY: 0,
        sx,
        sy: sx,
        clearTop: 0,
        clearBottom: window.innerHeight,
      }
    }
    const sy = (last + 1 - first) / window.innerHeight
    return {
      key,
      offsetX: 0,
      offsetY: first,
      sx,
      sy,
      clearTop: pureFirst < 0 ? 0 : (pureFirst - first) / sy,
      clearBottom:
        pureFirst < 0 ? window.innerHeight : (pureLast + 1 - first) / sy,
    }
  }

  const captureIfNeeded = () => {
    if (inflight) {
      pendingCapture = true
      return inflight
    }
    inflight = captureFrame().finally(() => {
      inflight = null
      renderPill()
      if (
        pendingCapture &&
        state === 'capturing' &&
        !autoDirection &&
        !finishing
      )
        scheduleIdleCapture()
    })
    return inflight
  }

  /** @returns {{ box: ReturnType<typeof visibleBoxOf>, range: Interval } | null} */
  const currentRange = () => {
    if (!target) return null
    const box = unobstructedBoxOf(target, visibleBoxOf(target))
    if (calibration) {
      // Skip the band under Safari's faded bars, except at the scroll ends where
      // that band can't be scrolled into the clear.
      const [min, max] = scrollRange(target)
      const scrollTop = getScrollTop(target)
      const top =
        scrollTop > min + 1 ? Math.max(box.top, calibration.clearTop) : box.top
      const bottom =
        scrollTop < max - 1
          ? Math.min(box.bottom, calibration.clearBottom)
          : box.bottom
      if (bottom - top > (box.bottom - box.top) * 0.5) {
        box.top = top
        box.bottom = bottom
      }
    }
    return {
      box,
      range: [
        position + (box.top - box.vp.top),
        position + (box.bottom - box.vp.top),
      ],
    }
  }

  /**
   * Content that grows while auto-scrolling (images loading, rows inserted) can push
   * the view past the captured edge; scroll back so the band in between isn't lost.
   * @param {1 | -1} direction
   */
  const closeGap = async (direction) => {
    for (let attempt = 0; attempt < 3 && target; attempt++) {
      const current = currentRange()
      const edge =
        direction > 0 ? coverage[coverage.length - 1]?.[1] : coverage[0]?.[0]
      if (!current || edge === undefined) return
      const gap =
        direction > 0 ? current.range[0] - edge : edge - current.range[1]
      if (gap <= 1) return
      setScrollTop(target, getScrollTop(target) - direction * (gap + 8))
      await settle()
      updatePosition()
    }
  }

  /**
   * Downscaled RGB rows of the frame's box, one row per CSS px.
   * @param {ImageBitmap} bitmap @param {Calibration} cal @param {ReturnType<typeof visibleBoxOf>} box
   */
  const signatureOf = (bitmap, cal, box) => {
    const height = Math.max(1, Math.round(box.bottom - box.top))
    const canvas = createCanvas(SIGNATURE_COLUMNS, height)
    const ctx = context2d(canvas)
    ctx.drawImage(
      bitmap,
      cal.offsetX + box.left * cal.sx,
      cal.offsetY + box.top * cal.sy,
      (box.right - box.left) * cal.sx,
      (box.bottom - box.top) * cal.sy,
      0,
      0,
      SIGNATURE_COLUMNS,
      height,
    )
    const rows = ctx.getImageData(0, 0, SIGNATURE_COLUMNS, height).data
    canvas.width = 0
    canvas.height = 0
    return rows
  }

  /**
   * Tracked positions drift when content reflows (rows prepended and regrouped).
   * Where this frame overlaps the previous one, find the small shift that makes
   * their pixels agree; keep the tracked position unless a shift is clearly better.
   * @param {Uint8ClampedArray} rows @param {Interval} range
   */
  const alignShift = (rows, range) => {
    const last = lastSignature
    if (!last) return 0
    const stride = SIGNATURE_COLUMNS * 4
    const newHeight = rows.length / stride
    const lastHeight = last.rows.length / stride
    /** @param {number} shift */
    const errorAt = (shift) => {
      const start = Math.ceil(Math.max(range[0] + shift, last.range[0]))
      const end = Math.floor(
        Math.min(range[0] + shift + newHeight, last.range[0] + lastHeight),
      )
      if (end - start < 40) return Infinity
      let sum = 0
      let count = 0
      for (let y = start; y < end; y++) {
        const a = Math.floor(y - (range[0] + shift)) * stride
        const b = Math.floor(y - last.range[0]) * stride
        for (let i = 0; i < stride; i += 4) {
          sum +=
            Math.abs((rows[a + i] ?? 0) - (last.rows[b + i] ?? 0)) +
            Math.abs((rows[a + i + 1] ?? 0) - (last.rows[b + i + 1] ?? 0)) +
            Math.abs((rows[a + i + 2] ?? 0) - (last.rows[b + i + 2] ?? 0))
          count += 3
        }
      }
      return sum / count
    }
    const base = errorAt(0)
    if (!Number.isFinite(base) || base < 2) return 0
    let best = 0
    let bestError = base
    for (let shift = -MAX_ALIGN_SHIFT; shift <= MAX_ALIGN_SHIFT; shift++) {
      if (!shift) continue
      const error = errorAt(shift)
      if (error < bestError) {
        best = shift
        bestError = error
      }
    }
    return bestError < base * 0.5 && bestError < 4 ? best : 0
  }

  const captureFrame = async () => {
    if (state !== 'capturing' || !target) return
    const session = generation
    try {
      if (!calibration || calibration.key !== viewportKey()) {
        calibration = await calibrate()
        if (session !== generation || !target) return
      }
      const cal = calibration
      updatePosition()
      const current = currentRange()
      if (!current) return
      const { box, range } = current
      if (box.right - box.left < 2 || !uncovered(range).length) return
      pendingCapture = false
      renderPill()
      const before = position
      const bitmap = await screenshot(box)
      if (session !== generation || !target) {
        bitmap.close()
        return
      }
      updatePosition()
      const moved = position - before
      // A shot taken while moving has an uncertain position. During slow manual
      // scrolls, the midpoint is close enough and beats leaving a gap.
      const tolerable = !autoDirection && Math.abs(moved) <= MAX_SHOT_DRIFT
      if ((Math.abs(moved) > 1 && !tolerable) || cal.key !== viewportKey()) {
        bitmap.close()
        pendingCapture = true
        return
      }
      if (Math.abs(moved) > 1) {
        range[0] += moved / 2
        range[1] += moved / 2
        pendingCapture = true
      }
      const signature = signatureOf(bitmap, cal, box)
      const shift = alignShift(signature, range)
      if (shift) {
        position += shift
        range[0] += shift
        range[1] += shift
      }
      if (!sessionScale) {
        sessionScale = settings.scale
          ? Math.min(settings.scale, cal.sx)
          : cal.sx
        frameWidthCss = box.right - box.left
      }
      const width = Math.round(frameWidthCss * sessionScale)
      /** @type {typeof pieces} */
      const framePieces = []
      for (const [a, b] of uncovered(range)) {
        const height = Math.max(1, Math.round((b - a) * sessionScale))
        const canvas = createCanvas(width, height)
        // Whole source rows: fractional ones blend in a neighbouring row, leaving seam lines.
        const sourceTop = Math.round(
          cal.offsetY + (box.top + (a - range[0])) * cal.sy,
        )
        const sourceHeight = Math.max(
          1,
          Math.round(cal.offsetY + (box.top + (b - range[0])) * cal.sy) -
            sourceTop,
        )
        const ctx = context2d(canvas)
        ctx.imageSmoothingEnabled = sourceHeight !== height
        ctx.drawImage(
          bitmap,
          cal.offsetX + box.left * cal.sx,
          sourceTop,
          (box.right - box.left) * cal.sx,
          sourceHeight,
          0,
          0,
          width,
          height,
        )
        framePieces.push({
          y: a,
          height: b - a,
          blob: await canvasToBlob(canvas, 'image/png'),
        })
        canvas.width = 0
        canvas.height = 0
      }
      bitmap.close()
      if (session !== generation) return
      pieces.push(...framePieces)
      frameCount++
      lastSignature = { range: [range[0], range[1]], rows: signature }
      coverage = mergeIntervals([...coverage, range])
      if (!autoDirection && !finishing) scheduleEdgeStop()
    } catch (error) {
      captureErrors++
      console.error('[scrolling-screenshot] capture failed', error)
      if (captureErrors === 3) toast('Capture keeps failing. See console.')
    }
  }

  /** Waits for the DOM inside the target to stop changing (lazy loading, layout). */
  const settle = async (quietMs = 200, maxMs = 1500) => {
    await nextFrame()
    await nextFrame()
    const startedAt = Date.now()
    let lastMutation = Date.now()
    const watcher = new MutationObserver(() => {
      lastMutation = Date.now()
    })
    if (target) {
      watcher.observe(isDocumentTarget(target) ? document.body : target, {
        childList: true,
        subtree: true,
        attributes: true,
      })
    }
    while (
      Date.now() - lastMutation < quietMs &&
      Date.now() - startedAt < maxMs
    ) {
      await sleep(50)
    }
    watcher.disconnect()
  }

  /** @param {1 | -1} direction */
  const runAutoScroll = async (direction) => {
    if (!target) return
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    const run = ++autoRun
    autoDirection = direction
    renderPill()
    const active = () =>
      run === autoRun &&
      autoDirection === direction &&
      state === 'capturing' &&
      !finishing &&
      !!target
    while (active() && target) {
      await inflight
      await captureIfNeeded()
      // A shot is discarded when the content moved while it was taken (e.g. a lazy
      // loader inserted rows); retake it before scrolling on, or that band is lost.
      for (let retry = 0; retry < 4 && pendingCapture && active(); retry++) {
        await settle()
        updatePosition()
        await closeGap(direction)
        await captureIfNeeded()
      }
      if (!active() || !target) break
      const step = viewportOf(target).height * AUTO_SCROLL_STEP * direction
      const before = getScrollTop(target)
      const heightBefore = target.scrollHeight
      setScrollTop(target, before + step)
      await settle()
      updatePosition()
      const moved = Math.abs(getScrollTop(target) - before) >= 1
      if (moved) await closeGap(direction)
      if (!target) break
      if (moved) continue
      // At an edge: give lazy loaders a moment to append more content.
      const waitStart = Date.now()
      while (
        active() &&
        Date.now() - waitStart < 2000 &&
        target.scrollHeight === heightBefore
      ) {
        await sleep(100)
      }
      if (!active()) break
      await settle()
      setScrollTop(target, getScrollTop(target) + step)
      await settle()
      updatePosition()
      if (Math.abs(getScrollTop(target) - before) >= 1) continue
      await captureIfNeeded()
      if (!active()) return
      autoDirection = 0
      if (settings.autoStop) {
        await finish()
        return
      }
    }
    if (run !== autoRun) return
    autoDirection = 0
    renderPill()
  }

  /* --------------------------------- stitching -------------------------------- */

  const stitch = async () => {
    if (!pieces.length || !target) return []
    const scale = sessionScale
    const minY = coverage[0]?.[0] ?? 0
    const maxY = coverage[coverage.length - 1]?.[1] ?? 0
    const width = Math.round(frameWidthCss * scale)
    const totalHeight = Math.round((maxY - minY) * scale)
    const maxPartHeight = Math.min(
      MAX_CANVAS_SIDE,
      Math.floor(MAX_CANVAS_AREA / width),
    )
    const background = backgroundOf(target)
    /** @type {Part[]} */
    const result = []
    for (let partTop = 0; partTop < totalHeight; partTop += maxPartHeight) {
      const partHeight = Math.min(maxPartHeight, totalHeight - partTop)
      const canvas = createCanvas(width, partHeight)
      const ctx = context2d(canvas)
      ctx.fillStyle = background
      ctx.fillRect(0, 0, width, partHeight)
      for (const piece of pieces) {
        const top = Math.round((piece.y - minY) * scale)
        const bottom = Math.round((piece.y + piece.height - minY) * scale)
        if (bottom <= partTop || top >= partTop + partHeight) continue
        const bitmap = await createImageBitmap(piece.blob)
        ctx.drawImage(bitmap, 0, top - partTop, width, bottom - top)
        bitmap.close()
      }
      const blob = await canvasToBlob(canvas, 'image/png')
      result.push({
        blob,
        url: URL.createObjectURL(blob),
        width,
        height: partHeight,
      })
      canvas.width = 0
      canvas.height = 0
    }
    return result
  }

  const finish = async () => {
    if (state !== 'capturing' || finishing) return
    finishing = true
    autoDirection = 0
    autoRun++
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    renderPill()
    const session = generation
    // Each screenshot times out, so this can't wait forever.
    await inflight
    await captureIfNeeded()
    if (session !== generation) return
    observer?.disconnect()
    unlistenScroll()
    if (!pieces.length) {
      toast('Nothing captured')
      cancel()
      return
    }
    setState('processing')
    try {
      const minY = coverage[0]?.[0] ?? 0
      const maxY = coverage[coverage.length - 1]?.[1] ?? 0
      const gaps = coverage.length - 1
      const stitched = await stitch()
      if (session !== generation) {
        for (const part of stitched) URL.revokeObjectURL(part.url)
        return
      }
      parts = stitched
      const first = parts[0]
      resultStem = fileStem()
      resultInfo = [
        first
          ? `${first.width} × ${Math.round((maxY - minY) * sessionScale).toLocaleString()} px`
          : '',
        `${frameCount} frame${frameCount === 1 ? '' : 's'}`,
        parts.length > 1 ? `${parts.length} images (size limit)` : '',
        gaps > 0
          ? `${gaps} gap${gaps === 1 ? '' : 's'} (scrolled too fast)`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
      pieces = []
      finishing = false
      setState('result')
    } catch (error) {
      console.error('[scrolling-screenshot] stitching failed', error)
      toast('Stitching failed. See console.')
      cancel()
    }
  }

  /* ---------------------------------- export ---------------------------------- */

  const fileStem = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `scrolling-screenshot-${location.host.replace(/[^\w.-]/g, '')}-${stamp}`
  }

  /** @param {Blob} blob @param {string} name */
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  /** @param {string} stem */
  const pngFiles = (stem) =>
    parts.map(
      (part, index) =>
        new File(
          [part.blob],
          parts.length > 1 ? `${stem}-${index + 1}.png` : `${stem}.png`,
          { type: 'image/png' },
        ),
    )

  /**
   * Minimal PDF writer: each page is one JPEG slice, sized at 0.75pt per CSS pixel.
   * @param {Array<{ jpeg: Uint8Array, widthPx: number, heightPx: number, widthPt: number, heightPt: number }>} pages
   */
  const buildPdf = (pages) => {
    const encoder = new TextEncoder()
    /** @type {Uint8Array[]} */
    const chunks = []
    /** @type {number[]} */
    const offsets = []
    let length = 0
    /** @param {string | Uint8Array} data */
    const push = (data) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data
      chunks.push(bytes)
      length += bytes.length
    }
    /** @param {number} id @param {string} body @param {Uint8Array} [stream] */
    const object = (id, body, stream) => {
      offsets[id] = length
      push(`${id} 0 obj\n${body}\n`)
      if (stream) {
        push('stream\n')
        push(stream)
        push('\nendstream\n')
      }
      push('endobj\n')
    }
    push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n')
    const pageIds = pages.map((_, index) => 3 + index * 3)
    object(1, '<< /Type /Catalog /Pages 2 0 R >>')
    object(
      2,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    )
    pages.forEach((page, index) => {
      const pageId = 3 + index * 3
      const contentId = pageId + 1
      const imageId = pageId + 2
      const w = page.widthPt.toFixed(2)
      const h = page.heightPt.toFixed(2)
      const content = encoder.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)
      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      )
      object(contentId, `<< /Length ${content.length} >>`, content)
      object(
        imageId,
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
        page.jpeg,
      )
    })
    const objectCount = 3 + pages.length * 3
    const xrefOffset = length
    push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`)
    for (let id = 1; id < objectCount; id++) {
      push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
    }
    push(
      `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    )
    return new Blob(/** @type {BlobPart[]} */ (chunks), {
      type: 'application/pdf',
    })
  }

  const exportPdf = async () => {
    const scale = sessionScale || 1
    const maxPageHeightPx = Math.floor((MAX_PDF_PAGE_PT / 0.75) * scale)
    /** @type {Parameters<typeof buildPdf>[0]} */
    const pages = []
    for (const part of parts) {
      const bitmap = await createImageBitmap(part.blob)
      for (let top = 0; top < part.height; top += maxPageHeightPx) {
        const heightPx = Math.min(maxPageHeightPx, part.height - top)
        const canvas = createCanvas(part.width, heightPx)
        const ctx = context2d(canvas)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, part.width, heightPx)
        ctx.drawImage(
          bitmap,
          0,
          top,
          part.width,
          heightPx,
          0,
          0,
          part.width,
          heightPx,
        )
        const jpeg = new Uint8Array(
          await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
        )
        pages.push({
          jpeg,
          widthPx: part.width,
          heightPx,
          widthPt: (part.width / scale) * 0.75,
          heightPt: (heightPx / scale) * 0.75,
        })
        canvas.width = 0
        canvas.height = 0
      }
      bitmap.close()
    }
    return buildPdf(pages)
  }

  /** @param {string} action */
  const runResultAction = async (action) => {
    const stem = resultStem || fileStem()
    if (action.startsWith('png:')) {
      const file = pngFiles(stem)[Number(action.slice(4))]
      if (file) download(file, file.name)
      return
    }
    if (action === 'pdf') {
      toast('Building PDF…')
      download(await exportPdf(), `${stem}.pdf`)
      return
    }
    if (action === 'share') {
      try {
        await navigator.share({ files: pngFiles(stem) })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          toast('Sharing failed')
      }
      return
    }
    if (action === 'copy') {
      const part = parts[0]
      if (!part) return
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': part.blob }),
        ])
        toast('Copied image')
      } catch {
        toast('Copy failed')
      }
    }
  }

  /* --------------------------------- rendering -------------------------------- */

  const trackHighlight = () => {
    cancelAnimationFrame(highlightRaf)
    const tick = () => {
      if (state === 'idle' || state === 'result') return
      positionHighlight()
      highlightRaf = requestAnimationFrame(tick)
    }
    highlightRaf = requestAnimationFrame(tick)
  }

  const positionHighlight = () => {
    if (!ui) return
    const el =
      state === 'confirm' || state === 'pick' || state === 'armed'
        ? candidate
        : target
    const { highlight } = ui
    if (!el || state === 'processing') {
      highlight.style.display = 'none'
      return
    }
    const { top, left, bottom, right } = visibleBoxOf(el)
    highlight.dataset.mode = state === 'capturing' ? 'outline' : 'tint'
    Object.assign(highlight.style, {
      display: 'block',
      top: `${top}px`,
      left: `${left}px`,
      width: `${Math.max(0, right - left)}px`,
      height: `${Math.max(0, bottom - top)}px`,
    })
  }

  const renderPill = () => {
    if (!ui) return
    const { pill } = ui
    if (state === 'armed') {
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot" data-idle></span>
        <span class="label">Scroll the area to capture</span>
        <button data-action="pick">Pick area</button>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'capturing' && finishing) {
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot" data-idle></span>
        <span class="label">Finishing…</span>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'capturing') {
      const covered = coverage.reduce((sum, [a, b]) => sum + (b - a), 0)
      const status =
        coverage.length > 1
          ? '<span class="label warn">Gap: scroll back slower</span>'
          : `<span class="label">${frameCount} · ${formatPx(covered)}${inflight ? ' …' : ''}</span>`
      const autoButtons = autoDirection
        ? '<button data-action="auto-stop">Pause</button>'
        : '<button data-action="auto-up" aria-label="Auto-scroll up">Auto ↑</button><button data-action="auto-down" aria-label="Auto-scroll down">Auto ↓</button>'
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot"></span>
        ${status}
        ${autoButtons}
        <button data-action="stop" data-danger>Stop</button>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'processing') {
      pill.hidden = false
      pill.innerHTML =
        '<span class="dot" data-idle></span><span class="label">Stitching…</span>'
      return
    }
    pill.hidden = true
    pill.innerHTML = ''
  }

  const renderSheet = () => {
    if (!ui) return
    const { sheet, catcher } = ui
    catcher.style.display = state === 'pick' ? 'block' : 'none'
    if (state === 'confirm' && candidate) {
      const contentHeight = isDocumentTarget(candidate)
        ? scrollingElement().scrollHeight
        : candidate.scrollHeight
      sheet.hidden = false
      sheet.innerHTML = /* html */ `
        <p>Capture this area?</p>
        <small>The highlighted area will be captured (${escapeHtml(formatPx(contentHeight))} of content loaded).</small>
        <div class="row">
          <button data-action="use" data-primary>Use this</button>
          <button data-action="pick">Pick another</button>
          <button data-action="cancel">Cancel</button>
        </div>
      `
      return
    }
    if (state === 'pick') {
      sheet.hidden = false
      sheet.innerHTML = /* html */ `
        <p>${candidate ? 'Selected area' : 'Tap the area to capture'}</p>
        <small>${candidate ? 'Adjust the selection or tap somewhere else.' : 'The nearest scrollable area around your tap gets selected.'}</small>
        <div class="row">
          <button data-action="bigger" ${candidate && nextScrollableAncestor(candidate) ? '' : 'disabled'}>↑ Bigger</button>
          <button data-action="smaller" ${pickStack.length ? '' : 'disabled'}>↓ Smaller</button>
          <button data-action="use" data-primary ${candidate ? '' : 'disabled'}>Use this</button>
          <button data-action="cancel">Cancel</button>
        </div>
      `
      return
    }
    sheet.hidden = true
    sheet.innerHTML = ''
  }

  const renderResult = () => {
    if (!ui) return
    const { result } = ui
    if (state !== 'result') {
      result.hidden = true
      result.innerHTML = ''
      return
    }
    const canShare =
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: pngFiles('check') })
    const canCopy =
      parts.length === 1 &&
      typeof ClipboardItem !== 'undefined' &&
      !!navigator.clipboard?.write
    result.hidden = false
    // Safari drops all but the last of several downloads started by one tap,
    // so each part gets its own button.
    result.innerHTML = /* html */ `
      <header>
        <span class="label">${escapeHtml(resultInfo)}</span>
        ${parts
          .map(
            (_, index) =>
              `<button data-action="png:${index}"${index ? '' : ' data-primary'}>Save PNG${parts.length > 1 ? ` ${index + 1}/${parts.length}` : ''}</button>`,
          )
          .join('')}
        <button data-action="pdf">Save PDF</button>
        ${canShare ? '<button data-action="share">Share</button>' : ''}
        ${canCopy ? '<button data-action="copy">Copy</button>' : ''}
        <button data-action="close">Close</button>
      </header>
      <div class="images">
        ${parts.map((part, index) => `<img src="${part.url}" alt="Scrolling screenshot part ${index + 1}" width="${part.width}" height="${part.height}">`).join('')}
      </div>
    `
  }

  const render = () => {
    if (!ui) return
    if (state === 'idle') {
      ui.highlight.style.display = 'none'
      ui.catcher.style.display = 'none'
    }
    renderPill()
    renderSheet()
    renderResult()
    positionHighlight()
  }

  /** @param {Event} event */
  function onUiClick(event) {
    const button =
      event.target instanceof Element
        ? event.target.closest('button[data-action]')
        : null
    if (!(button instanceof HTMLButtonElement) || button.disabled) return
    const action = button.dataset.action ?? ''
    switch (action) {
      case 'cancel':
      case 'close':
        cancel()
        return
      case 'pick':
        setState('pick')
        return
      case 'use':
        if (!candidate) return
        saveArea(selectorFor(candidate))
        beginCapture(candidate)
        return
      case 'bigger': {
        if (!candidate) return
        const parent = nextScrollableAncestor(candidate)
        if (!parent) return
        pickStack.push(candidate)
        candidate = parent
        render()
        return
      }
      case 'smaller': {
        const previous = pickStack.pop()
        if (previous) candidate = previous
        render()
        return
      }
      case 'auto-up':
        void runAutoScroll(-1)
        return
      case 'auto-down':
        void runAutoScroll(1)
        return
      case 'auto-stop':
        autoDirection = 0
        renderPill()
        return
      case 'stop':
        void finish()
        return
      default:
        void runResultAction(action)
    }
  }

  /** @param {MouseEvent} event */
  function onCatcherClick(event) {
    if (!ui) return
    ui.catcher.style.display = 'none'
    const scrollable = scrollableAt(event.clientX, event.clientY)
    ui.catcher.style.display = 'block'
    if (!scrollable) {
      toast('No scrollable area there')
      return
    }
    candidate = scrollable
    pickStack = []
    render()
  }

  /* --------------------------------- trigger ---------------------------------- */

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'toggle') return
    if (state === 'idle') void start()
    else if (state === 'capturing') void finish()
    else if (state !== 'processing') cancel()
  })
})()
