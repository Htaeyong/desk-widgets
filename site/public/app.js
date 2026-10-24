// Download page logic (#99). Reads GitHub release data at runtime; the page works without it ("준비 중").
// The mapping helpers are plain functions so engine/test/site.test.js can run them in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeskSite = api;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => api.init(document));
})(typeof self !== 'undefined' ? self : this, function () {
  const REPO = 'Htaeyong/desk-widgets';
  const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  const RELEASES_URL = `https://github.com/${REPO}/releases`;
  const CACHE_KEY = 'desk-widgets-releases-v1';
  const CACHE_MS = 10 * 60 * 1000;

  const ENGINE_TAG = /^engine-v(\d+(?:\.\d+)*)$/;
  const WIDGET_TAG = /^widget-([a-z0-9][a-z0-9-]*)-v(\d+(?:\.\d+)*)$/;

  function compareVersions(a, b) {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /** Installer file name a release of this product must carry (same scheme as scripts/release.js productInfo). */
  function assetName(product, version) {
    return product.id === 'engine'
      ? `DeskWidgets-Setup-${version}.exe`
      : `DeskWidgets-${product.productName}-Setup-${version}.exe`;
  }

  /**
   * Newest published release per product: { engine: {version, url, tag, page}, widgets: { <id>: {...} } }.
   * Drafts, prereleases, unknown tags and releases without the expected installer are ignored.
   */
  function pickLatest(releases, products) {
    const byId = { engine: products.engine };
    for (const w of products.widgets) byId[w.id] = w;
    const best = {};
    for (const r of Array.isArray(releases) ? releases : []) {
      if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
      let id;
      let version;
      let m;
      if ((m = ENGINE_TAG.exec(r.tag_name))) { id = 'engine'; version = m[1]; }
      else if ((m = WIDGET_TAG.exec(r.tag_name))) { id = m[1]; version = m[2]; }
      else continue;
      const product = byId[id];
      if (!product || (id !== 'engine' && !product.productName)) continue;
      const name = assetName(product, version);
      const asset = (r.assets || []).find((a) => a && a.name === name && a.browser_download_url);
      if (!asset) continue;
      if (best[id] && compareVersions(best[id].version, version) >= 0) continue;
      best[id] = { version, tag: r.tag_name, url: asset.browser_download_url, page: r.html_url || RELEASES_URL };
    }
    const widgets = {};
    for (const w of products.widgets) if (best[w.id]) widgets[w.id] = best[w.id];
    return { engine: best.engine || null, widgets };
  }

  async function loadReleases(fetchImpl, storage, now) {
    try {
      const cached = JSON.parse(storage.getItem(CACHE_KEY));
      if (cached && now - cached.at < CACHE_MS && Array.isArray(cached.releases)) return cached.releases;
    } catch { /* no cache */ }
    const res = await fetchImpl(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const releases = await res.json();
    try { storage.setItem(CACHE_KEY, JSON.stringify({ at: now, releases })); } catch { /* storage unavailable */ }
    return releases;
  }

  function el(doc, tag, attrs, children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children || []) if (c) node.append(c);
    return node;
  }

  /** Fills one download button: a real link when the installer is known, else a disabled "준비 중" state. */
  function setDownload(link, label, latest, versionNode) {
    if (latest) {
      link.setAttribute('href', latest.url);
      link.removeAttribute('aria-disabled');
      link.classList.remove('is-pending');
      link.textContent = label;
      if (versionNode) versionNode.textContent = `v${latest.version}`;
    } else {
      link.setAttribute('href', RELEASES_URL);
      link.setAttribute('aria-disabled', 'true');
      link.classList.add('is-pending');
      link.textContent = label === '다운로드' ? '준비 중' : `${label} (준비 중)`;
    }
  }

  /** Screenshot gallery of one card: the big picture plus a thumbnail per image (click or keyboard switches it). */
  function renderGallery(doc, w, images) {
    const main = el(doc, 'img', { class: 'shot-main', src: images[0].src, alt: images[0].caption ? `${w.name}: ${images[0].caption}` : `${w.name} 위젯 화면`, loading: 'lazy' });
    const caption = el(doc, 'p', { class: 'shot-caption', text: images[0].caption || '' });
    const gallery = el(doc, 'div', { class: 'gallery' }, [el(doc, 'div', { class: 'shot' }, [main]), caption]);
    if (images.length > 1) {
      const thumbs = el(doc, 'div', { class: 'thumbs', role: 'group', 'aria-label': `${w.name} 화면 고르기` });
      images.forEach((image, i) => {
        const button = el(doc, 'button', { type: 'button', class: i ? 'thumb' : 'thumb is-on', 'aria-label': image.caption || `화면 ${i + 1}`, 'aria-pressed': i ? 'false' : 'true' }, [
          el(doc, 'img', { src: image.src, alt: '', loading: 'lazy' }),
        ]);
        button.addEventListener('click', () => {
          main.setAttribute('src', image.src);
          main.setAttribute('alt', image.caption ? `${w.name}: ${image.caption}` : `${w.name} 위젯 화면`);
          caption.textContent = image.caption || '';
          for (const other of thumbs.children) {
            other.classList.toggle('is-on', other === button);
            other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
          }
        });
        thumbs.append(button);
      });
      gallery.append(thumbs);
    }
    return gallery;
  }

  function renderWidgets(doc, products, showcase) {
    const list = doc.getElementById('widget-list');
    list.textContent = '';
    for (const w of products.widgets) {
      const extra = (showcase && showcase[w.id]) || {};
      const images = extra.images && extra.images.length ? extra.images : (w.image ? [{ src: w.image, caption: '' }] : []);
      const version = el(doc, 'span', { class: 'ver', text: `v${w.version}`, 'data-version-for': w.id });
      list.append(el(doc, 'li', { class: 'card', id: `w-${w.id}` }, [
        images.length ? renderGallery(doc, w, images) : null,
        el(doc, 'div', { class: 'body' }, [
          el(doc, 'h3', {}, [w.name, ' ', version]),
          el(doc, 'p', { class: 'desc', text: w.description }),
          extra.features && extra.features.length ? el(doc, 'ul', { class: 'features' }, extra.features.map((f) => el(doc, 'li', { text: f }))) : null,
          extra.requires ? el(doc, 'p', { class: 'requires' }, [el(doc, 'strong', { text: '필요한 것 ' }), extra.requires]) : null,
          el(doc, 'p', { class: 'meta', text: `필요한 엔진: ${w.engineMin ? w.engineMin : `엔진 API ${w.engineApi}`} 이상` }),
          el(doc, 'a', { class: 'btn small is-pending', href: RELEASES_URL, 'data-download': w.id, 'aria-disabled': 'true', text: '준비 중' }),
        ]),
      ]));
    }
  }

  function applyLatest(doc, products, latest) {
    setDownload(doc.getElementById('download-engine'), '엔진 다운로드', latest.engine, doc.getElementById('engine-version'));
    for (const w of products.widgets) {
      setDownload(doc.querySelector(`[data-download="${w.id}"]`), '다운로드', latest.widgets[w.id], doc.querySelector(`[data-version-for="${w.id}"]`));
    }
    const any = latest.engine || Object.keys(latest.widgets).length;
    doc.getElementById('release-note').textContent = any ? '' : '아직 공개된 설치 파일이 없습니다. 준비되면 이 자리에서 바로 내려받을 수 있습니다.';
  }

  async function init(doc) {
    const products = await (await fetch('products.json')).json();
    // The feature lists and screenshots are an extra: the cards still work without showcase.json.
    const showcase = await fetch('showcase.json').then((res) => (res.ok ? res.json() : null)).catch(() => null);
    renderWidgets(doc, products, showcase);
    doc.getElementById('engine-version').textContent = `v${products.engine.version}`;
    applyLatest(doc, products, { engine: null, widgets: {} });
    try {
      const storage = globalThis.sessionStorage || { getItem() { return null; }, setItem() {} };
      const releases = await loadReleases(fetch.bind(globalThis), storage, Date.now());
      applyLatest(doc, products, pickLatest(releases, products));
    } catch {
      doc.getElementById('release-note').textContent = '릴리스 정보를 불러오지 못했습니다. 아래 "릴리스 페이지"에서 내려받아 주세요.';
    }
  }

  return { REPO, API_URL, RELEASES_URL, compareVersions, assetName, pickLatest, loadReleases, applyLatest, init };
});
