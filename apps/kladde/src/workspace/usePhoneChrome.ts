import { useEffect, useRef, useState } from "react";
import type { Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { followEdgeSwipe } from "./edgeSwipe";
import { showPicture, viewKey } from "./viewMemory";
import {
  dismissKeyboardOnTouch,
  followViewport,
  onChromeAction,
  showChrome,
  watchOverlays,
  type ChromeAction,
  type RootTab,
} from "../platform/chrome";
import { loadCapture } from "./lazyParts";

interface PhoneChrome {
  mobile: boolean;
  t: T;
  tab: RootTab;
  page: Page | null | undefined;
  theme: string;
  dark: boolean;
  behind: string;
  ai: boolean;
  nativeChrome: boolean;
  setNativeChrome: (shown: boolean) => void;
  act: (action: ChromeAction) => void;
  back: () => void;
}

function chromeLabels(t: T) {
  return {
    home: t("home"),
    pages: t("pages"),
    search: t("search"),
    ai: t("ai"),
    add: t("createNew"),
    back: t("back"),
    favorite: t("favorite"),
    more: t("more"),
    settings: t("settings"),
  };
}

interface Gestures {
  act: (action: ChromeAction) => void;
  covered: (covered: boolean) => void;
  canSwipe: () => boolean;
  back: () => void;
  under: (surface: HTMLElement) => HTMLElement | null;
}

function followPhone(gestures: Gestures) {
  void loadCapture();
  const stopActions = onChromeAction(gestures.act);
  const stopOverlays = watchOverlays(gestures.covered);
  const stopKeyboard = dismissKeyboardOnTouch();
  const stopViewport = followViewport();
  const stopSwipe = followEdgeSwipe({
    surface: () =>
      document.querySelector<HTMLElement>(".phone .work > .document"),
    underlay: gestures.under,
    enabled: gestures.canSwipe,
    back: gestures.back,
  });

  return () => {
    stopSwipe();
    stopActions();
    stopOverlays();
    stopKeyboard();
    stopViewport();
  };
}

function useNativeBars(chrome: PhoneChrome, covered: boolean) {
  const { mobile, t, tab, page, theme, dark, behind, ai, setNativeChrome } =
    chrome;
  const opened = !!page,
    favorite = !!page?.favorite,
    shownView = viewKey(page?.id ?? null, tab);

  useEffect(() => {
    if (!mobile) return;
    let current = true;

    void showChrome({
      bar: !covered,
      tab,
      top: covered ? "none" : opened ? "page" : "root",
      favorite,
      dark: theme === "system" ? null : dark,
      view: shownView,
      behind: opened ? behind : null,
      ai,
      labels: chromeLabels(t),
    }).then((shown) => {
      if (current) setNativeChrome(shown);
    });

    return () => {
      current = false;
    };
  }, [
    mobile,
    covered,
    tab,
    opened,
    favorite,
    theme,
    dark,
    shownView,
    behind,
    ai,
    t,
  ]);
}

export function usePhoneChrome(chrome: PhoneChrome) {
  const [covered, setCovered] = useState(false);
  const act = useRef(chrome.act),
    swipeBack = useRef<(() => void) | null>(null),
    swipeUnder = useRef<(surface: HTMLElement) => HTMLElement | null>(
      () => null,
    );

  act.current = chrome.act;
  swipeBack.current =
    chrome.page && !covered && !chrome.nativeChrome ? chrome.back : null;
  swipeUnder.current = (surface) => showPicture(chrome.behind, surface);
  useEffect(() => {
    if (!chrome.mobile) return;

    return followPhone({
      act: (action) => act.current(action),
      covered: setCovered,
      canSwipe: () => !!swipeBack.current,
      back: () => swipeBack.current?.(),
      under: (surface) => swipeUnder.current(surface),
    });
  }, [chrome.mobile]);
  useNativeBars(chrome, covered);
}
