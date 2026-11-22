var ClipPage = function () {};

ClipPage.prototype = (function () {
  var MAX_VISITED = 20000;
  var MAX_IMAGES = 20;
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  var MAX_IMAGE_TOTAL = 12 * 1024 * 1024;
  var IMAGE_TIMEOUT_MS = 5000;
  var IMAGE_DEADLINE_MS = 12000;
  var CONTENT = "article, main, [role=main]";
  var WEB = /^https?:$/;
  var DROPPED =
    "script,style,noscript,template,iframe,frame,object,embed,svg,canvas,video,audio,link";

  function absolute(value) {
    try {
      return new URL(value, document.baseURI).href;
    } catch (error) {
      return "";
    }
  }

  function invisible(element) {
    if (typeof element.checkVisibility !== "function") return false;
    return (
      !element.checkVisibility() &&
      getComputedStyle(element).display !== "contents"
    );
  }

  function settle(live, copy) {
    if (invisible(live)) {
      copy.setAttribute("hidden", "");
      return;
    }
    if (live instanceof HTMLImageElement)
      copy.setAttribute("src", live.currentSrc || live.src);
    if (live instanceof HTMLAnchorElement && live.href)
      copy.setAttribute("href", live.href);
  }

  function settleAll(liveRoot, copyRoot) {
    var live = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
    var copy = document.createTreeWalker(copyRoot, NodeFilter.SHOW_ELEMENT);
    for (var seen = 0; seen < MAX_VISITED; seen++) {
      if (!live.nextNode() || !copy.nextNode()) return;
      settle(live.currentNode, copy.currentNode);
    }
  }

  function absolutize(root) {
    root.querySelectorAll("img[src]").forEach(function (image) {
      image.setAttribute("src", absolute(image.getAttribute("src")));
    });
    root.querySelectorAll("a[href]").forEach(function (link) {
      link.setAttribute("href", absolute(link.getAttribute("href")));
    });
  }

  function serialize(root) {
    root.querySelectorAll(DROPPED).forEach(function (node) {
      node.remove();
    });
    return "<!doctype html>" + root.outerHTML;
  }

  function wholePage() {
    var copy = document.documentElement.cloneNode(true);
    var body = copy.querySelector("body");
    if (document.body && body) settleAll(document.body, body);
    return serialize(copy);
  }

  function selectedPart() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return "";
    var part = document.createDocumentFragment();
    for (var index = 0; index < selection.rangeCount; index++)
      part.append(selection.getRangeAt(index).cloneContents());
    absolutize(part);
    var page = document.implementation.createHTMLDocument(document.title);
    page.body.append(part);
    return serialize(page.documentElement);
  }

  function isWeb(address) {
    try {
      return WEB.test(new URL(address).protocol);
    } catch (error) {
      return false;
    }
  }

  function sources(root) {
    if (!root) return [];
    return Array.prototype.map.call(root.querySelectorAll("img"), function (image) {
      return absolute(image.currentSrc || image.getAttribute("src") || "");
    });
  }

  function selectedSources() {
    var selection = window.getSelection();
    var found = [];
    if (!selection || selection.isCollapsed) return found;
    for (var index = 0; index < selection.rangeCount; index++)
      found = found.concat(sources(selection.getRangeAt(index).cloneContents()));
    return found;
  }

  function candidates() {
    var all = selectedSources()
      .concat(sources(document.querySelector(CONTENT)))
      .concat(sources(document.body));
    var unique = all.filter(function (address, index) {
      return isWeb(address) && all.indexOf(address) === index;
    });
    return unique.slice(0, MAX_IMAGES);
  }

  function encode(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        resolve(text.slice(text.indexOf(",") + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function fetchImage(address, budget) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, IMAGE_TIMEOUT_MS);
    return fetch(address, { credentials: "include", signal: controller.signal })
      .then(function (response) {
        return response.ok ? response.blob() : null;
      })
      .then(function (blob) {
        if (!blob || !blob.size || blob.size > Math.min(MAX_IMAGE_BYTES, budget)) return null;
        return encode(blob).then(function (data) {
          return { url: address, data: data, size: blob.size };
        });
      })
      .catch(function () {
        return null;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function collectImages(addresses) {
    var deadline = Date.now() + IMAGE_DEADLINE_MS;
    var images = [];
    var budget = MAX_IMAGE_TOTAL;
    var next = function (index) {
      if (index >= addresses.length || budget <= 0 || Date.now() > deadline)
        return Promise.resolve(images);
      return fetchImage(addresses[index], budget).then(function (image) {
        if (image) {
          budget -= image.size;
          images.push({ url: image.url, data: image.data });
        }
        return next(index + 1);
      });
    };
    return next(0);
  }

  function attempt(read) {
    try {
      return read();
    } catch (error) {
      return "";
    }
  }

  return {
    run: function (parameters) {
      var result = {
        url: document.location.href,
        title: document.title,
        html: attempt(wholePage),
        selection: attempt(selectedPart),
        images: [],
      };
      var finish = function (images) {
        result.images = images;
        parameters.completionFunction(result);
      };
      collectImages(attempt(candidates) || []).then(finish, function () {
        finish([]);
      });
    },
    finalize: function () {},
  };
})();

var ExtensionPreprocessingJS = new ClipPage();
