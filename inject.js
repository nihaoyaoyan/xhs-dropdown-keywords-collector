// inject.js —— 注入页面主世界(MAIN world)：记录全部请求 + 截获联想响应
(function () {
  if (window.__xhsSugPatched) return;
  window.__xhsSugPatched = true;
  window.__xhsNetLog = [];

  function logReq(url) {
    if (typeof url !== 'string') return;
    if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return;
    window.__xhsNetLog.push(url);
    if (window.__xhsNetLog.length > 300) window.__xhsNetLog.shift();
  }

  function isSuggestUrl(url) {
    if (typeof url !== 'string') return false;
    return /search.*(recommend|suggest|input|keyword|hot)|(recommend|suggest_words|search_keywords|hot_search|associational|autocomplete)/i.test(url);
  }

  function emit(url, data) {
    try {
      window.dispatchEvent(new CustomEvent('xhs-sug-captured', { detail: { url: url, data: data } }));
    } catch (e) {}
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function () {
      var args = arguments;
      var url = (args[0] && args[0].url) || (typeof args[0] === 'string' ? args[0] : '');
      logReq(url);
      var resp = await origFetch.apply(this, args);
      try {
        if (isSuggestUrl(url)) {
          resp.clone().json().then(function (d) { emit(url, d); }).catch(function () {});
        }
      } catch (e) {}
      return resp;
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xhsSugUrl = url;
    logReq(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('load', function () {
      try {
        if (isSuggestUrl(self.__xhsSugUrl)) {
          var d;
          try { d = JSON.parse(self.responseText); } catch (e) { d = self.responseText; }
          emit(self.__xhsSugUrl, d);
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
