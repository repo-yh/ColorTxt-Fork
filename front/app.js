var SEGMENT_SIZE = 500

var $content = document.getElementById('content')
var $btn = document.getElementById('btnRefresh')
var $select = document.getElementById('fileSelect')
var $sidebar = document.getElementById('sidebar')
var $sidebarPanel = document.getElementById('sidebarPanel')
var $sidebarTab = document.getElementById('sidebarTab')
var $chapterList = document.getElementById('chapterList')
var $main = document.getElementById('main')
var $stickyChapter = document.getElementById('stickyChapter')
var $btnFontMinus = document.getElementById('btnFontMinus')
var $btnFontPlus = document.getElementById('btnFontPlus')
var $sentinel = null
var $sentinelTop = null

// 动态对齐工具栏底边（移动端工具栏fixed，桌面sticky）
function alignStickyChapter() {
  var tb = document.querySelector('.toolbar')
  if (tb) {
    var rect = tb.getBoundingClientRect()
    $stickyChapter.style.top = rect.bottom + 'px'
    $stickyChapter.style.left = rect.left + 'px'
    $stickyChapter.style.right = (window.innerWidth - rect.right) + 'px'
  }
}
window.addEventListener('resize', alignStickyChapter)
window.addEventListener('scroll', alignStickyChapter, { passive: true })
alignStickyChapter()
var currentFile = ''
var chapters = []
var totalLines = 0
var sidebarOpen = false
var loadedRanges = []
var loadingSegment = false

function updateStickyChapter() {
  if (!chapters.length) { $stickyChapter.style.display = 'none'; return }
  var topLine = findTopVisibleLine()
  if (topLine === null) { $stickyChapter.style.display = 'none'; return }
  var cur = null
  for (var i = 0; i < chapters.length; i++) {
    if (chapters[i].line <= topLine) cur = chapters[i]
    else break
  }
  if (cur) {
    $stickyChapter.textContent = cur.title
    $stickyChapter.style.display = 'block'
  } else {
    $stickyChapter.style.display = 'none'
  }
}
window.addEventListener('scroll', updateStickyChapter, { passive: true })

function findTopVisibleLine() {
  var children = document.getElementById('content').children
  for (var i = 0; i < children.length; i++) {
    var cid = children[i].id
    if (cid && /^L\d+$/.test(cid)) {
      if (children[i].getBoundingClientRect().top >= 60) {
        return parseInt(cid.slice(1))
      }
    }
  }
  return null
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen
  $sidebar.classList.toggle('open', sidebarOpen)
  $main.classList.toggle('shifted', sidebarOpen)
  document.body.classList.toggle('sidebar-open', sidebarOpen)
  $sidebarTab.innerHTML = sidebarOpen ? '&#9664;' : '&#9654;'

  // transform 平移结束后重新对齐吸顶章节标题
  setTimeout(alignStickyChapter, 250)
}

// ---- 阅读进度保存 ----

var saveProgressTimer = null

function saveProgress() {
  if (!currentFile) return
  var line = findTopVisibleLine()
  if (line === null) return
  var map = {}
  try { map = JSON.parse(localStorage.getItem('colortxt_web_progress')) || {} } catch(e) {}
  if (typeof map !== 'object' || Array.isArray(map)) map = {}
  map[currentFile] = line
  try { localStorage.setItem('colortxt_web_progress', JSON.stringify(map)) } catch(e) {}
}

// 滚动停止 500ms 后保存，避免滚动过程中频繁写 localStorage
window.addEventListener('scroll', function() {
  clearTimeout(saveProgressTimer)
  saveProgressTimer = setTimeout(saveProgress, 500)
}, { passive: true })

// 关闭页面兜底
window.addEventListener('beforeunload', function() {
  clearTimeout(saveProgressTimer)
  saveProgress()
})

function showStatus(text, isError) {
  $content.innerHTML = '<div id="status"' + (isError ? ' class="error"' : '') + '>' + text + '</div>'
  $chapterList.innerHTML = ''
  $stickyChapter.style.display = 'none'
  $sentinel = null
}

function renderChapters(list) {
  chapters = list || []
  $chapterList.innerHTML = chapters.map(function(c) {
    return '<span class="chapterItem" onclick="jumpToLine(' + c.line + ')">' + c.title + '</span>'
  }).join('')
  updateStickyChapter()
}

// ---- 分段加载 ----

function isLineLoaded(line) {
  for (var i = 0; i < loadedRanges.length; i++) {
    if (line >= loadedRanges[i].start && line <= loadedRanges[i].end) return true
  }
  return false
}

function isRangeLoaded(start, end) {
  for (var i = 0; i < loadedRanges.length; i++) {
    if (loadedRanges[i].start <= start && loadedRanges[i].end >= end) return true
  }
  return false
}

function addLoadedRange(start, end) {
  var newRanges = []
  var inserted = false
  for (var i = 0; i < loadedRanges.length; i++) {
    var r = loadedRanges[i]
    if (r.end < start - 1) {
      newRanges.push(r)
    } else if (r.start > end + 1) {
      if (!inserted) { newRanges.push({ start: start, end: end }); inserted = true }
      newRanges.push(r)
    } else {
      start = Math.min(start, r.start)
      end = Math.max(end, r.end)
    }
  }
  if (!inserted) newRanges.push({ start: start, end: end })
  loadedRanges = newRanges
}

function getRangeForLine(line) {
  var start = Math.floor(line / SEGMENT_SIZE) * SEGMENT_SIZE
  var end = start + SEGMENT_SIZE - 1
  if (totalLines > 0) end = Math.min(end, totalLines - 1)
  return { start: start, end: end }
}

function findNextUnloaded() {
  var next = 0
  for (var i = 0; i < loadedRanges.length; i++) {
    if (loadedRanges[i].start <= next) {
      next = Math.max(next, loadedRanges[i].end + 1)
    } else break
  }
  if (next >= totalLines) return null
  return { start: next, end: Math.min(next + SEGMENT_SIZE - 1, totalLines - 1) }
}

function removeSentinel() {
  if ($sentinel && $sentinel.parentNode) $sentinel.parentNode.removeChild($sentinel)
  $sentinel = null
  if ($sentinelTop && $sentinelTop.parentNode) $sentinelTop.parentNode.removeChild($sentinelTop)
  $sentinelTop = null
  if (window._sentinelObserver) { window._sentinelObserver.disconnect(); window._sentinelObserver = null }
}

function setupSentinel() {
  removeSentinel()
  var $c = document.getElementById('content')
  if (findNextUnloaded()) {
    $sentinel = document.createElement('div')
    $sentinel.id = 'sentinel'
    $sentinel.style.height = '1px'
    $c.appendChild($sentinel)
    observeSentinel($sentinel)
  }
  if (findPrevUnloaded()) {
    $sentinelTop = document.createElement('div')
    $sentinelTop.id = 'sentinelTop'
    $sentinelTop.style.height = '1px'
    $c.insertBefore($sentinelTop, $c.firstChild)
    observeSentinel($sentinelTop)
  }
}

function observeSentinel(el) {
  if (!window._sentinelObserver) {
    window._sentinelObserver = new IntersectionObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue
        if (entries[i].target.id === 'sentinel') loadNextSegment()
        else if (entries[i].target.id === 'sentinelTop') loadPrevSegment()
      }
    }, { rootMargin: '3000px' })
  }
  window._sentinelObserver.observe(el)
}

function clearContent() {
  removeSentinel()
  document.getElementById('content').innerHTML = ''
  loadedRanges = []
}

async function loadSegment(start, end, refresh) {
  if (isRangeLoaded(start, end)) return
  if (loadingSegment) return
  loadingSegment = true

  try {
    var url = '/api/content?file=' + encodeURIComponent(currentFile) + '&start=' + start + '&end=' + end
    if (refresh) url += '&refresh=1'
    var r = await fetch(url)
    var data = await r.json()
    if (!data.ok) { loadingSegment = false; setupSentinel(); return }

    totalLines = data.total
    if (data.theme === 'vs-dark') {
      document.body.classList.add('dark')
    } else {
      document.body.classList.remove('dark')
    }

    // 章节数据：有则更新
    if (Array.isArray(data.chapters) && data.chapters.length) {
      renderChapters(data.chapters)
    }
    if (start === 0) {
      alignStickyChapter()
    }

    // 移除占位状态
    var statusEl = document.getElementById('status')
    if (statusEl) statusEl.remove()

    // 解析新行，插入到正确位置
    var temp = document.createElement('div')
    temp.innerHTML = data.html

    var $c = document.getElementById('content')
    // 找到插入点：第一个行号 > start 的元素之前
    var insertBefore = null
    var children = $c.children
    for (var i = 0; i < children.length; i++) {
      var cid = children[i].id
      if (cid && /^L\d+$/.test(cid)) {
        if (parseInt(cid.slice(1)) > start) { insertBefore = children[i]; break }
      }
    }

    var frag = document.createDocumentFragment()
    while (temp.firstChild) frag.appendChild(temp.firstChild)
    if (insertBefore) {
      $c.insertBefore(frag, insertBefore)
    } else {
      $c.appendChild(frag)
    }

    addLoadedRange(data.start, data.end)
    setupSentinel()
  } catch (e) {
    // 失败时重建 sentinel，滚动触发重试
    setupSentinel()
  } finally {
    loadingSegment = false
  }
}

function loadNextSegment() {
  var next = findNextUnloaded()
  if (next) {
    loadSegment(next.start, next.end)
  }
}

function findPrevUnloaded() {
  var first = loadedRanges[0]
  if (!first || first.start <= 0) return null
  var end = first.start - 1
  var start = Math.max(0, end - SEGMENT_SIZE + 1)
  return { start: start, end: end }
}

async function loadPrevSegment() {
  var prev = findPrevUnloaded()
  if (!prev || loadingSegment) return
  var oldHeight = document.documentElement.scrollHeight
  await loadSegment(prev.start, prev.end)
  // 向上插入内容后补偿滚动位置，保持视口不跳动
  var delta = document.documentElement.scrollHeight - oldHeight
  if (delta > 0) window.scrollBy(0, delta)
}

async function loadFile(filePath, forceRefresh) {
  $btn.disabled = true

  showStatus('正在加载...', false)
  currentFile = filePath
  loadedRanges = []
  totalLines = 0
  chapters = []
  removeSentinel()

  try {
    try { localStorage.setItem('colortxt_web_file', currentFile) } catch(e) {}
    if (currentFile) $select.value = currentFile
    // 恢复阅读进度：只加载进度行所在三段
    var savedLine = 0
    try { savedLine = (JSON.parse(localStorage.getItem('colortxt_web_progress')) || {})[currentFile] || 0 } catch(e) {}
    if (savedLine > 0) {
      await jumpToLine(savedLine, forceRefresh)
    } else {
      await loadSegment(0, SEGMENT_SIZE - 1, forceRefresh)
    }
  } catch (e) {
    showStatus('连接失败：请确认 ColorTxt 已开启 Web 展示服务', true)
  } finally {
    $btn.disabled = false
  }
}

function scrollToLine(line) {
  var el = document.getElementById('L' + line)
  if (!el) return
  el.style.position = 'static'
  el.scrollIntoView({ behavior: 'instant', block: 'start' })
  requestAnimationFrame(function() { el.style.position = '' })
}

async function jumpToLine(line, refresh) {
  if (!isLineLoaded(line)) {
    // 跳转到未加载区域：清理本地正文缓存，只保留目标三段
    clearContent()
  }
  var range = getRangeForLine(line)
  var prevStart = Math.max(0, range.start - SEGMENT_SIZE)
  var nextEnd = range.end + SEGMENT_SIZE
  if (totalLines > 0) nextEnd = Math.min(nextEnd, totalLines - 1)
  // 只加载章节所在段与前后各一段预填充，粒度与滚动加载一致
  if (range.start > 0 && !isRangeLoaded(prevStart, range.start - 1)) {
    await loadSegment(prevStart, range.start - 1, refresh)
  }
  if (!isLineLoaded(line)) {
    await loadSegment(range.start, range.end, refresh)
  }
  if (range.end < nextEnd && !isRangeLoaded(range.end + 1, nextEnd)) {
    await loadSegment(range.end + 1, nextEnd, refresh)
  }
  scrollToLine(line)
  updateStickyChapter()
  setupSentinel()
}

async function loadFiles() {
  try {
    var r = await fetch('/api/files')
    var data = await r.json()
    if (!data.ok || !data.files) return ''
    $select.innerHTML = '<option value="">-- 选择文件 --</option>'
    data.files.forEach(function(f) {
      var opt = document.createElement('option')
      opt.value = f.path
      opt.textContent = f.name + (f.active ? ' [当前]' : '')
      if (f.active) { opt.selected = true; currentFile = f.path }
      $select.appendChild(opt)
    })
    return currentFile
  } catch (e) { return '' }
}

function onFileChange() {
  var v = $select.value
  if (v) { saveProgress(); loadFile(v) }
}

// ---- 字体大小调节 ----

var FONT_MIN = 12, FONT_MAX = 40

function applyFontSize(size) {
  $content.style.setProperty('--content-size', size + 'px')
  $btnFontMinus.disabled = size <= FONT_MIN
  $btnFontPlus.disabled = size >= FONT_MAX
}

function changeFontSize(delta) {
  var cur = parseInt(getComputedStyle($content).getPropertyValue('--content-size')) || 16
  var next = Math.min(FONT_MAX, Math.max(FONT_MIN, cur + delta))
  if (next === cur) return
  applyFontSize(next)
  try { localStorage.setItem('colortxt_web_font_size', String(next)) } catch(e) {}
}

try {
  var savedSize = parseInt(localStorage.getItem('colortxt_web_font_size')) || 0
  if (savedSize >= FONT_MIN && savedSize <= FONT_MAX) applyFontSize(savedSize)
} catch(e) {}

loadFiles().then(function() {
  var saved = ''
  try { saved = localStorage.getItem('colortxt_web_file') || '' } catch(e) {}
  if (saved) {
    loadFile(saved)
    $select.value = saved
  }
})
