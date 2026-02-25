
class ClaudeTimelineManager {
  constructor() {
    this.scrollContainer = null;
    this.conversationContainer = null;
    this.markers = [];
    this.activeTurnId = null;
    this.ui = { timelineBar: null, tooltip: null };
    this.isScrolling = false;

    this.mutationObserver = null;
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.themeObserver = null;
    this.visibleUserTurns = new Set();
    this.onTimelineBarClick = null;
    this.onScroll = null;
    this.onTimelineBarOver = null;
    this.onTimelineBarOut = null;
    this.onWindowResize = null;
    this.onTimelineWheel = null;
    this.scrollRafId = null;
    this.lastActiveChangeTime = 0;
    this.minActiveChangeInterval = 120;
    this.pendingActiveId = null;
    this.activeChangeTimer = null;
    this.tooltipHideDelay = 100;
    this.tooltipHideTimer = null;
    this.measureCanvas = null;
    this.measureCtx = null;
    this.showRafId = null;

    // Long-canvas track
    this.ui.track = null;
    this.ui.trackContent = null;
    this.scale = 1;
    this.contentHeight = 0;
    this.yPositions = [];
    this.visibleRange = { start: 0, end: -1 };
    this.firstUserTurnOffset = 0;
    this.contentSpanPx = 1;
    this.usePixelTop = false;
    this._cssVarTopSupported = null;

    // Left-side slider
    this.ui.slider = null;
    this.ui.sliderHandle = null;
    this.sliderDragging = false;
    this.sliderFadeTimer = null;
    this.sliderFadeDelay = 1000;
    this.sliderAlwaysVisible = false;
    this.onSliderDown = null;
    this.onSliderMove = null;
    this.onSliderUp = null;
    this.markersVersion = 0;

    this.debouncedRecalculateAndRender = this.debounce(this.recalculateAndRenderMarkers, 350);

    // Star state
    this.starred = new Set();
    this.markerMap = new Map();
    this.conversationId = this.extractConversationIdFromPath(location.pathname);

    // Long-press
    this.longPressDuration = 550;
    this.longPressMoveTolerance = 6;
    this.longPressTimer = null;
    this.longPressTriggered = false;
    this.pressStartPos = null;
    this.pressTargetDot = null;
    this.suppressClickUntil = 0;

    // Cross-tab sync
    this.onStorage = null;
  }

  debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  async init() {
    const elementsFound = await this.findCriticalElements();
    if (!elementsFound) return;

    this.injectTimelineUI();
    this.setupEventListeners();
    this.setupObservers();
    try { this.recalculateAndRenderMarkers(); } catch { }
    this.conversationId = this.extractConversationIdFromPath(location.pathname);
    this.loadStars();

    // Sync star state
    try {
      for (let i = 0; i < this.markers.length; i++) {
        const m = this.markers[i];
        const want = this.starred.has(m.id);
        if (m.starred !== want) {
          m.starred = want;
          if (m.dotElement) {
            try {
              m.dotElement.classList.toggle('starred', m.starred);
              m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
            } catch { }
          }
        }
      }
    } catch { }
  }

  async findCriticalElements() {
    // 根据用户提供的类名精准定位消息列表容器
    // 类名：flex-1 flex flex-col px-4 max-w-3xl mx-auto w-full pt-1
    const containerSelector = '.flex-1.flex.flex-col.px-4.max-w-3xl.mx-auto.w-full.pt-1';
    this.conversationContainer = await this.waitForElement(containerSelector);

    if (!this.conversationContainer) {
      // 备选方案：如果精准类名匹配不到，尝试原有的启发式搜索
      const firstTurn = await this.waitForElement('div.font-claude-message, [data-testid="user-message"], [data-turn-id]');
      if (firstTurn) {
        this.conversationContainer = firstTurn.parentElement;
      }
    }

    if (!this.conversationContainer) return false;

    // 向上查找滚动容器
    let parent = this.conversationContainer;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        this.scrollContainer = parent;
        break;
      }
      parent = parent.parentElement;
    }

    if (!this.scrollContainer) {
      this.scrollContainer = document.scrollingElement || document.documentElement || document.body;
    }

    return true;
  }

  waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const target = document.querySelector(selector);
        if (target) {
          observer.disconnect();
          resolve(target);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  injectTimelineUI() {
    let bar = document.querySelector('.chatgpt-timeline-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'chatgpt-timeline-bar';
      document.body.appendChild(bar);
    }
    this.ui.timelineBar = bar;

    let track = bar.querySelector('.timeline-track');
    if (!track) {
      track = document.createElement('div');
      track.className = 'timeline-track';
      bar.appendChild(track);
    }
    this.ui.track = track;

    let content = track.querySelector('.timeline-track-content');
    if (!content) {
      content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
    }
    this.ui.trackContent = content;

    let slider = document.querySelector('.timeline-left-slider');
    if (!slider) {
      slider = document.createElement('div');
      slider.className = 'timeline-left-slider';
      const handle = document.createElement('div');
      handle.className = 'timeline-left-handle';
      slider.appendChild(handle);
      document.body.appendChild(slider);
    }
    this.ui.slider = slider;
    this.ui.sliderHandle = slider.querySelector('.timeline-left-handle');

    if (!this.ui.tooltip) {
      const tip = document.createElement('div');
      tip.className = 'timeline-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.id = 'chatgpt-timeline-tooltip';
      document.body.appendChild(tip);
      this.ui.tooltip = tip;

      if (!this.measureCanvas) {
        this.measureCanvas = document.createElement('canvas');
        this.measureCtx = this.measureCanvas.getContext('2d');
      }
    }
  }

  recalculateAndRenderMarkers() {
    if (!this.conversationContainer || !this.ui.timelineBar || !this.scrollContainer || !this.ui.trackContent) {
      return;
    }

    // 根据用户提供的类名定位用户消息：mb-1 mt-6 group
    const userTurns = Array.from(this.conversationContainer.querySelectorAll('div.mb-1.mt-6.group'));

    if (userTurns.length === 0) return;

    this.ui.trackContent.querySelectorAll('.timeline-dot').forEach(n => n.remove());

    const firstOffset = userTurns[0].offsetTop;
    let contentSpan = 1;
    if (userTurns.length > 1) {
      contentSpan = userTurns[userTurns.length - 1].offsetTop - firstOffset;
    }
    if (contentSpan <= 0) contentSpan = 1;

    this.firstUserTurnOffset = firstOffset;
    this.contentSpanPx = contentSpan;

    this.markerMap.clear();
    this.markers = userTurns.map((el, idx) => {
      const offset = el.offsetTop - firstOffset;
      let n = offset / contentSpan;
      n = Math.max(0, Math.min(1, n));

      // Stable ID for Claude
      const id = el.getAttribute('data-turn-id') || `claude-turn-${idx}`;
      const m = {
        id,
        element: el,
        summary: this.normalizeText(el.textContent || ''),
        n,
        baseN: n,
        dotElement: null,
        starred: false,
      };
      m.starred = this.starred.has(m.id);
      this.markerMap.set(id, m);
      return m;
    });

    this.markersVersion++;
    this.updateTimelineGeometry();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateActiveDotUI();
    this.scheduleScrollSync();
  }

  normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  getTrackPadding() {
    if (!this.ui.timelineBar) return 12;
    const v = getComputedStyle(this.ui.timelineBar).getPropertyValue('--timeline-track-padding').trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 12;
  }

  getMinGap() {
    if (!this.ui.timelineBar) return 12;
    const v = getComputedStyle(this.ui.timelineBar).getPropertyValue('--timeline-min-gap').trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 12;
  }

  applyMinGap(positions, minTop, maxTop, gap) {
    const n = positions.length;
    if (n === 0) return positions;
    const out = positions.slice();

    out[0] = Math.max(minTop, Math.min(positions[0], maxTop));
    for (let i = 1; i < n; i++) {
      const minAllowed = out[i - 1] + gap;
      out[i] = Math.max(positions[i], minAllowed);
    }

    if (out[n - 1] > maxTop) {
      out[n - 1] = maxTop;
      for (let i = n - 2; i >= 0; i--) {
        const maxAllowed = out[i + 1] - gap;
        out[i] = Math.min(out[i], maxAllowed);
      }

      if (out[0] < minTop) {
        out[0] = minTop;
        for (let i = 1; i < n; i++) {
          const minAllowed = out[i - 1] + gap;
          out[i] = Math.max(positions[i], minAllowed);
        }
      }
    }

    for (let i = 0; i < n; i++) {
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }
    return out;
  }

  detectCssVarTopSupport(pad, usableSpan) {
    try {
      if (!this.ui.trackContent) return false;
      const test = document.createElement('button');
      test.className = 'timeline-dot';
      test.style.visibility = 'hidden';
      test.style.pointerEvents = 'none';
      test.setAttribute('aria-hidden', 'true');
      const expected = pad + 0.5 * usableSpan;
      test.style.setProperty('--n', '0.5');
      this.ui.trackContent.appendChild(test);
      const cs = getComputedStyle(test);
      const topStr = cs.top || '';
      const px = parseFloat(topStr);
      test.remove();
      if (!Number.isFinite(px)) return false;
      return Math.abs(px - expected) <= 2;
    } catch {
      return false;
    }
  }

  updateTimelineGeometry() {
    if (!this.ui.timelineBar || !this.ui.trackContent) return;

    const barHeight = this.ui.timelineBar.clientHeight || 0;
    const pad = this.getTrackPadding();
    const minGap = this.getMinGap();
    const count = this.markers.length;

    const desiredHeight = Math.max(
      barHeight,
      count > 0 ? (2 * pad + Math.max(0, count - 1) * minGap) : barHeight
    );
    this.contentHeight = Math.ceil(desiredHeight);
    this.ui.trackContent.style.height = `${this.contentHeight}px`;

    const usableSpan = Math.max(1, this.contentHeight - 2 * pad);
    const desiredY = this.markers.map(m => {
      const n = typeof m.baseN === 'number' ? m.baseN : (m.n || 0);
      const clamped = Math.max(0, Math.min(1, n));
      return pad + clamped * usableSpan;
    });

    const adjusted = this.applyMinGap(desiredY, pad, pad + usableSpan, minGap);
    this.yPositions = adjusted;

    for (let i = 0; i < count; i++) {
      const top = adjusted[i];
      const n = (top - pad) / usableSpan;
      this.markers[i].n = Math.max(0, Math.min(1, n));
      if (this.markers[i].dotElement && !this.usePixelTop) {
        try {
          this.markers[i].dotElement.style.setProperty('--n', String(this.markers[i].n));
        } catch { }
      }
    }

    if (this._cssVarTopSupported === null) {
      this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableSpan);
      this.usePixelTop = !this._cssVarTopSupported;
    }
  }

  syncTimelineTrackToMain() {
    if (!this.scrollContainer || !this.ui.track) return;
    const scrollRatio = this.scrollContainer.scrollTop / (this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight || 1);
    const maxTrackScroll = this.ui.trackContent.clientHeight - this.ui.track.clientHeight;
    if (maxTrackScroll > 0) {
      this.ui.track.scrollTop = scrollRatio * maxTrackScroll;
    }
  }

  updateVirtualRangeAndRender() {
    if (!this.ui.trackContent || this.markers.length === 0) return;

    const total = this.markers.length;
    const haveY = this.yPositions && this.yPositions.length === total;

    this.markers.forEach((m, idx) => {
      if (!m.dotElement) {
        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        dot.dataset.targetTurnId = m.id;
        if (m.starred) dot.classList.add('starred');

        if (haveY && this.usePixelTop) {
          const top = this.yPositions[idx];
          dot.style.top = `${Math.round(top)}px`;
        } else if (haveY) {
          const n = m.n != null ? m.n : ((this.yPositions[idx] - this.getTrackPadding()) / Math.max(1, this.contentHeight - 2 * this.getTrackPadding()));
          dot.style.setProperty('--n', String(Math.max(0, Math.min(1, n))));
        } else {
          const top = m.n * (this.contentHeight - 12);
          dot.style.top = `${top}px`;
        }

        this.ui.trackContent.appendChild(dot);
        m.dotElement = dot;
      } else if (haveY) {
        if (this.usePixelTop) {
          const top = this.yPositions[idx];
          m.dotElement.style.top = `${Math.round(top)}px`;
        } else {
          m.dotElement.style.setProperty('--n', String(m.n != null ? m.n : 0));
        }
      }
    });
  }

  updateActiveDotUI() {
    if (!this.activeTurnId || !this.ui.trackContent) return;
    this.ui.trackContent
      .querySelectorAll('.timeline-dot')
      .forEach(dot => {
        dot.classList.toggle('active', dot.dataset.targetTurnId === this.activeTurnId);
      });
  }

  scheduleScrollSync() {
    if (this.scrollRafId !== null) return;
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = null;
      // 同步时间轴轨道与主内容滚动
      this.syncTimelineTrackToMain();
      // 重新渲染时间轴上的节点
      this.updateVirtualRangeAndRender();
      // 根据当前滚动位置更新 active
      this.computeActiveByScroll();
      // 更新左侧滑块位置
      this.updateSlider();
    });
  }

  computeActiveByScroll() {
    if (!this.scrollContainer || this.markers.length === 0) return;

    const containerRect = this.scrollContainer.getBoundingClientRect();
    const scrollTop = this.scrollContainer.scrollTop;
    // 使用可视区域 45% 位置作为参考线，与 ChatGPT 时间轴逻辑保持一致
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;

    let activeId = this.markers[0].id;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const top = m.element.getBoundingClientRect().top - containerRect.top + scrollTop;
      if (top <= ref) {
        activeId = m.id;
      } else {
        break;
      }
    }

    if (this.activeTurnId !== activeId) {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const since = now - this.lastActiveChangeTime;
      if (since < this.minActiveChangeInterval) {
        // 快速滚动时合并频繁的 active 变化，避免高亮抖动
        this.pendingActiveId = activeId;
        if (!this.activeChangeTimer) {
          const delay = Math.max(this.minActiveChangeInterval - since, 0);
          this.activeChangeTimer = setTimeout(() => {
            this.activeChangeTimer = null;
            if (this.pendingActiveId && this.pendingActiveId !== this.activeTurnId) {
              this.activeTurnId = this.pendingActiveId;
              this.updateActiveDotUI();
              this.lastActiveChangeTime = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            }
            this.pendingActiveId = null;
          }, delay);
        }
      } else {
        this.activeTurnId = activeId;
        this.updateActiveDotUI();
        this.lastActiveChangeTime = now;
      }
    }
  }

  updateSlider() {
    if (!this.ui.slider || !this.scrollContainer) return;
    const scrollable = this.scrollContainer.scrollHeight > this.scrollContainer.clientHeight;
    this.ui.slider.style.display = scrollable ? 'block' : 'none';

    if (scrollable) {
      const ratio = this.scrollContainer.scrollTop / (this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight);
      const sliderHeight = this.ui.slider.clientHeight;
      const handleHeight = this.ui.sliderHandle.clientHeight;
      const top = ratio * (sliderHeight - handleHeight);
      this.ui.sliderHandle.style.transform = `translateY(${top}px)`;
    }
  }

  setupEventListeners() {
    this.onTimelineBarClick = (e) => {
      const dot = e.target.closest('.timeline-dot');
      if (dot) {
        const targetId = dot.dataset.targetTurnId;
        const m = this.markerMap.get(targetId);
        if (m && m.element) {
          // 仅负责滚动到对应消息，active 高亮交给滚动计算逻辑统一处理
          this.smoothScrollTo(m.element);
        }
      }
    };
    this.ui.timelineBar.addEventListener('click', this.onTimelineBarClick);

    // Tooltip
    this.ui.timelineBar.addEventListener('mouseover', (e) => {
      const dot = e.target.closest('.timeline-dot');
      if (dot) {
        const id = dot.dataset.targetTurnId;
        const m = this.markerMap.get(id);
        if (m) this.showTooltip(m, dot);
      }
    });
    this.ui.timelineBar.addEventListener('mouseout', () => this.hideTooltip());
  }

  smoothScrollTo(targetElement, duration = 600) {
    if (!this.scrollContainer || !targetElement) return;

    const containerRect = this.scrollContainer.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const targetPosition = targetRect.top - containerRect.top + this.scrollContainer.scrollTop;
    const startPosition = this.scrollContainer.scrollTop;
    const distance = targetPosition - startPosition;
    let startTime = null;

    const animation = (currentTime) => {
      this.isScrolling = true;
      if (startTime === null) startTime = currentTime;
      const timeElapsed = currentTime - startTime;
      const run = this.easeInOutQuad(timeElapsed, startPosition, distance, duration);
      this.scrollContainer.scrollTop = run;
      if (timeElapsed < duration) {
        requestAnimationFrame(animation);
      } else {
        this.scrollContainer.scrollTop = targetPosition;
        this.isScrolling = false;
      }
    };

    requestAnimationFrame(animation);
  }

  easeInOutQuad(t, b, c, d) {
    t /= d / 2;
    if (t < 1) return c / 2 * t * t + b;
    t--;
    return -c / 2 * (t * (t - 2) - 1) + b;
  }

  showTooltip(m, dot) {
    if (!this.ui.tooltip) return;
    this.ui.tooltip.textContent = (m.starred ? '★ ' : '') + m.summary;
    this.ui.tooltip.classList.add('visible');

    const dotRect = dot.getBoundingClientRect();
    const tipRect = this.ui.tooltip.getBoundingClientRect();

    this.ui.tooltip.style.top = `${dotRect.top + dotRect.height / 2 - tipRect.height / 2}px`;
    this.ui.tooltip.style.right = `${window.innerWidth - dotRect.left + 10}px`;
  }

  hideTooltip() {
    if (this.ui.tooltip) this.ui.tooltip.classList.remove('visible');
  }

  setupObservers() {
    this.mutationObserver = new MutationObserver(() => this.debouncedRecalculateAndRender());
    this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });

    this.resizeObserver = new ResizeObserver(() => {
      this.updateTimelineGeometry();
      this.syncTimelineTrackToMain();
    });
    this.resizeObserver.observe(this.ui.timelineBar);

    this.onScroll = () => this.scheduleScrollSync();
    this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
  }

  extractConversationIdFromPath(path) {
    const match = path.match(/\/chat\/([a-z0-9-]+)/);
    return match ? match[1] : null;
  }

  loadStars() {
    if (!this.conversationId) return;
    try {
      const saved = localStorage.getItem(`claudeTimelineStars:${this.conversationId}`);
      if (saved) {
        this.starred = new Set(JSON.parse(saved));
      }
    } catch { }
  }

  toggleStar(id) {
    if (this.starred.has(id)) {
      this.starred.delete(id);
    } else {
      this.starred.add(id);
    }
    this.saveStars();
    const m = this.markerMap.get(id);
    if (m && m.dotElement) {
      m.dotElement.classList.toggle('starred', this.starred.has(id));
    }
  }

  saveStars() {
    if (!this.conversationId) return;
    try {
      localStorage.setItem(`claudeTimelineStars:${this.conversationId}`, JSON.stringify(Array.from(this.starred)));
    } catch { }
  }

  destroy() {
    try { this.mutationObserver?.disconnect(); } catch { }
    try { this.resizeObserver?.disconnect(); } catch { }
    if (this.scrollContainer && this.onScroll) {
      try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch { }
    }
    if (this.ui.timelineBar) {
      try { this.ui.timelineBar.removeEventListener('click', this.onTimelineBarClick); } catch { }
    }
    try { this.ui.timelineBar?.remove(); } catch { }
    try { this.ui.tooltip?.remove(); } catch { }
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch { }
    this.scrollContainer = null;
    this.conversationContainer = null;
    this.ui = { timelineBar: null, tooltip: null, track: null, trackContent: null, slider: null, sliderHandle: null };
    this.markers = [];
    this.markerMap.clear();
    this.visibleUserTurns.clear();
  }
}

// Global Claude timeline state & SPA routing
let claudeTimelineManagerInstance = null;
let claudeCurrentUrl = location.href;
let claudeInitTimerId = null;
let claudeRouteListenersAttached = false;
let claudeRouteCheckIntervalId = null;
let claudeTimelineActive = true;
let claudeProviderEnabled = true;

function claudeInitializeTimeline() {
  if (claudeTimelineManagerInstance) {
    try { claudeTimelineManagerInstance.destroy(); } catch { }
    claudeTimelineManagerInstance = null;
  }
  claudeTimelineManagerInstance = new ClaudeTimelineManager();
  claudeTimelineManagerInstance.init().catch?.(() => {});
}

function claudeHandleUrlChange() {
  if (location.href === claudeCurrentUrl) return;
  claudeCurrentUrl = location.href;

  try {
    if (claudeInitTimerId) {
      clearTimeout(claudeInitTimerId);
      claudeInitTimerId = null;
    }
  } catch { }

  const enabled = claudeTimelineActive && claudeProviderEnabled;
  if (!enabled) {
    if (claudeTimelineManagerInstance) {
      try { claudeTimelineManagerInstance.destroy(); } catch { }
      claudeTimelineManagerInstance = null;
    }
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch { }
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch { }
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch { }
    return;
  }

  claudeInitTimerId = setTimeout(() => {
    claudeInitTimerId = null;
    if (claudeTimelineActive && claudeProviderEnabled) {
      claudeInitializeTimeline();
    }
  }, 300);
}

function claudeAttachRouteListenersOnce() {
  if (claudeRouteListenersAttached) return;
  claudeRouteListenersAttached = true;
  try { window.addEventListener('popstate', claudeHandleUrlChange); } catch { }
  try { window.addEventListener('hashchange', claudeHandleUrlChange); } catch { }
  try {
    claudeRouteCheckIntervalId = setInterval(() => {
      if (location.href !== claudeCurrentUrl) claudeHandleUrlChange();
    }, 800);
  } catch { }
}

function claudeSetupTimeline() {
  claudeAttachRouteListenersOnce();

  try {
    if (chrome?.storage?.local) {
      chrome.storage.local.get({ timelineActive: true, timelineProviders: {} }, (res) => {
        try { claudeTimelineActive = !!res.timelineActive; } catch { claudeTimelineActive = true; }
        try {
          const map = res.timelineProviders || {};
          claudeProviderEnabled = (typeof map.claude === 'boolean') ? map.claude : true;
        } catch { claudeProviderEnabled = true; }

        if (claudeTimelineActive && claudeProviderEnabled) {
          claudeInitializeTimeline();
        }
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes) return;
        let changed = false;
        if ('timelineActive' in changes) {
          claudeTimelineActive = !!changes.timelineActive.newValue;
          changed = true;
        }
        if ('timelineProviders' in changes) {
          try {
            const map = changes.timelineProviders.newValue || {};
            claudeProviderEnabled = (typeof map.claude === 'boolean') ? map.claude : true;
            changed = true;
          } catch { }
        }
        if (!changed) return;

        const enabled = claudeTimelineActive && claudeProviderEnabled;
        if (!enabled) {
          if (claudeTimelineManagerInstance) {
            try { claudeTimelineManagerInstance.destroy(); } catch { }
            claudeTimelineManagerInstance = null;
          }
          try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch { }
          try { document.querySelector('.timeline-left-slider')?.remove(); } catch { }
          try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch { }
        } else {
          claudeInitializeTimeline();
        }
      });
    } else {
      claudeInitializeTimeline();
    }
  } catch {
    claudeInitializeTimeline();
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  claudeSetupTimeline();
} else {
  window.addEventListener('DOMContentLoaded', claudeSetupTimeline);
}
