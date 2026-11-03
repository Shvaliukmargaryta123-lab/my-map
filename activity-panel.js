(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    panel: $("activityPanel"), close: $("activityClose"), tab: $("activityTab"),
    alert: $("activityAlert"), updated: $("activityUpdated"), total: $("activityTotal"),
    list: $("activityList"), launches: $("activityLaunches"), connection: $("activityConnection"),
    telegramOpen: $("telegramPostsOpen"), telegramModal: $("telegramModal"),
    telegramClose: $("telegramPostsClose"), telegramRefresh: $("telegramPostsRefresh"),
    telegramFeed: $("telegramPostsFeed"), telegramStatus: $("telegramPostsStatus"),
    cityWatchName: $("cityWatchName"), cityWatchOpen: $("cityWatchOpen"),
    cityWatchScan: $("cityWatchScan"), cityWatchSetup: $("cityWatchSetup"),
    cityWatchInput: $("cityWatchInput"), cityWatchSearch: $("cityWatchSearch"),
    cityWatchResults: $("cityWatchResults"), cityWatchSelected: $("cityWatchSelected"),
    cityWatchSave: $("cityWatchSave"), cityWatchClear: $("cityWatchClear"),
    cityThreatAlert: $("cityThreatAlert"), cityThreatAlertText: $("cityThreatAlertText"),
    cityThreatShow: $("cityThreatShow"),
    uav: $("countUav"), uavSplit: $("uavSplit"), ballistic: $("countBallistic"),
    kab: $("countKab"), fpv: $("countFpv"),
  };
  const colors = { uav: "#e9ad39", ballistic: "#ff6683", kab: "#ff9367", fpv: "#8da8ff", missile: "#ff7189", other: "#c4cfda" };
  const labels = { uav: "БпЛА", recon: "Розвід-БпЛА", fpv: "FPV-дрон", ballistic: "Балістика", kab: "КАБ", missile: "Ракета", mig31k: "МіГ-31К", other: "Невідома ціль" };
  const icons = { uav: "⌁", recon: "⌁", fpv: "✣", ballistic: "↗", kab: "◇", missile: "➤", mig31k: "✈", other: "•" };
  let alertsReceived = false;
  let threatReceived = false;
  let threatError = false;
  let telegramPostsLoading = false;
  let telegramPostsTimer = null;
  let watchedCity = null;
  let selectedWatchCity = null;
  let latestThreatSnapshot = [];
  const launchMarkers = new Map();
  const UKRAINE_CENTER = [31.1656, 48.3794];
  const LAUNCH_MARKER_MAX_AGE = 60 * 60 * 1000;
  try {
    const storedCity = JSON.parse(localStorage.getItem("zn-watch-city") || "null");
    if (storedCity && Number.isFinite(Number(storedCity.lat)) && Number.isFinite(Number(storedCity.lon))) watchedCity = storedCity;
  } catch (error) { console.warn("Could not restore saved city:", error); }

  function norm(t) { return String(t || "").toLowerCase().normalize("NFKC").replace(/[’`]/g, "'").replace(/[_-]+/g, " ").trim(); }
  function describe(t) { return norm([t?.type, t?.title, t?.kind, t?.category, t?.explanationShort].filter(Boolean).join(" ")); }
  function category(t) {
    const s = describe(t);
    if (/fpv|first person|фпв/.test(s)) return "fpv";
    if (/ballistic|баліст/.test(s)) return "ballistic";
    if (/kab|guided bomb|каб|керован.*бомб/.test(s)) return "kab";
    if (/mig.?31|мiг.?31|авіац|aircraft|aviation/.test(s)) return "other";
    if (/cruise|missile|ракета/.test(s)) return "missile";
    if (/uav|drone|shahed|shahid|recon|розвід|бпла|шахед/.test(s)) return "uav";
    return "other";
  }
  function quantity(t) {
    const n = Number(t?.count ?? t?.quantity ?? t?.number);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  function isReactive(t) { return /react|jet|реакт|реактив/.test(describe(t)); }
  function isOrdinaryUav(t) { return /shahed|shahid|шахед|звичайн|ordinary|conventional/.test(describe(t)) && !isReactive(t); }
  function safeText(v, fallback = "") { return String(v ?? fallback); }
  function timeLabel(t) {
    const value = t?.updatedAt || t?.updated_at || t?.confirmedAt || t?.createdAt || t?.created_at;
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(date) : "—";
  }
  function location(t) { return t?.locality || t?.district || t?.region || t?.oblast || "Місце не вказано"; }

  function threatKey(t) { return String(t?.id || `${t?.type}-${t?.lat}-${t?.lon}`); }
  function distanceKm(a, b) {
    const rad = value => value * Math.PI / 180;
    const lat1 = rad(Number(a.lat)), lat2 = rad(Number(b.lat));
    const dLat = lat2 - lat1, dLon = rad(Number(b.lon) - Number(a.lon));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  function scanWatchedCity() {
    if (!watchedCity) {
      ui.cityThreatAlert.hidden = true;
      ui.cityWatchScan.classList.remove("is-active");
      ui.cityWatchScan.querySelector("span").textContent = "Оберіть місто для моніторингу в радіусі 40 км";
      return;
    }
    const checkedAt = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    ui.cityWatchScan.classList.toggle("is-active", threatReceived && !threatError);
    ui.cityWatchScan.querySelector("span").textContent = threatError
      ? `Немає оновлень API · остання перевірка ${checkedAt}`
      : !threatReceived
        ? "Очікуємо підключення до API · зона моніторингу 40 км"
        : `Перевіряємо повітряний простір у радіусі 40 км · ${checkedAt}`;
    const nearby = latestThreatSnapshot.filter(t => {
      if (!t || norm(t.status) === "resolved" || !["uav", "fpv", "ballistic"].includes(category(t))) return false;
      const raw = window.znGetThreatPosition?.(threatKey(t)) || { lat: t.lat, lon: t.lon };
      if (raw.lat == null || raw.lon == null || !Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lon))) return false;
      const km = distanceKm(watchedCity, raw);
      return Number.isFinite(km) && km <= 40;
    }).map(t => {
      const position = window.znGetThreatPosition?.(threatKey(t)) || { lat: t.lat, lon: t.lon };
      return { threat: t, distance: distanceKm(watchedCity, position) };
    }).sort((a, b) => a.distance - b.distance);
    if (!nearby.length) {
      ui.cityThreatAlert.hidden = true;
      return;
    }
    const kinds = [...new Set(nearby.map(({ threat }) => {
      const type = category(threat);
      return type === "ballistic" ? "балістика" : type === "fpv" ? "FPV-дрон" : "БпЛА";
    }))];
    const closest = nearby[0];
    const title = safeText(closest.threat.title, labels[category(closest.threat)] || "Ціль");
    ui.cityThreatAlertText.textContent = `${watchedCity.name}: ${kinds.join(" та ")} у радіусі 40 км. Найближча ціль — ${title}, приблизно ${Math.round(closest.distance)} км. Перейдіть в укриття.${threatError ? " Дані API можуть бути застарілими." : ""}`;
    ui.cityThreatShow.dataset.threatId = threatKey(closest.threat);
    ui.cityThreatAlert.hidden = false;
  }

  function updateWatchedCityUI() {
    ui.cityWatchName.textContent = watchedCity?.name || "Місто не обрано";
    ui.cityWatchOpen.textContent = watchedCity ? "ЗМІНИТИ МІСТО" : "СЛІДКУВАТИ ЗА МІСТОМ";
    ui.cityWatchClear.hidden = !watchedCity;
    scanWatchedCity();
  }

  function chooseWatchCity(city) {
    selectedWatchCity = city;
    ui.cityWatchSelected.textContent = `Обрано: ${city.name}${city.context ? ` · ${city.context}` : ""}`;
    ui.cityWatchSelected.hidden = false;
    ui.cityWatchSave.disabled = false;
    for (const option of ui.cityWatchResults.querySelectorAll("[role=option]")) option.setAttribute("aria-selected", String(option.dataset.cityName === city.name && Number(option.dataset.cityLat) === city.lat && Number(option.dataset.cityLon) === city.lon));
  }

  async function findWatchCities() {
    const query = ui.cityWatchInput.value.trim();
    ui.cityWatchResults.replaceChildren();
    ui.cityWatchSelected.hidden = true;
    ui.cityWatchSave.disabled = true;
    selectedWatchCity = null;
    if (!query) {
      ui.cityWatchResults.textContent = "Введіть назву міста для пошуку.";
      return;
    }
    ui.cityWatchSearch.disabled = true;
    ui.cityWatchSearch.textContent = "ШУКАЄМО…";
    try {
      const response = await fetch(`/api/city-search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const places = (payload.features || []).filter(feature => {
        const properties = feature?.properties || {};
        const coordinates = feature?.geometry?.coordinates || [];
        const [lon, lat] = coordinates;
        const kind = String(properties.osm_value || properties.type || "").toLowerCase();
        const isPlace = properties.osm_key === "place" || ["city", "town", "village", "municipality", "locality", "hamlet"].includes(kind);
        return isPlace && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
      });
      if (!places.length) {
        ui.cityWatchResults.textContent = "Місто не знайдено. Спробуйте іншу назву.";
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const feature of places) {
        const properties = feature.properties || {};
        const [lon, lat] = feature.geometry.coordinates.map(Number);
        const name = String(properties.name || properties.city || properties.town || properties.village || "Місто");
        const context = [properties.state, properties.country].filter((value, index, all) => value && all.indexOf(value) === index && value !== name).join(", ");
        const city = { name, context, lat, lon };
        const option = document.createElement("button");
        option.type = "button";
        option.className = "city-watch__option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.dataset.cityName = name;
        option.dataset.cityLat = String(lat);
        option.dataset.cityLon = String(lon);
        option.textContent = context ? `${name} · ${context}` : name;
        option.addEventListener("click", () => chooseWatchCity(city));
        fragment.append(option);
      }
      ui.cityWatchResults.append(fragment);
    } catch (error) {
      console.warn("City lookup error:", error);
      ui.cityWatchResults.textContent = "Не вдалося виконати пошук міста. Спробуйте ще раз трохи пізніше.";
    } finally {
      ui.cityWatchSearch.disabled = false;
      ui.cityWatchSearch.textContent = "ЗНАЙТИ";
    }
  }

  function renderThreats(input) {
    threatReceived = true;
    threatError = false;
    const threats = (Array.isArray(input) ? input : []).filter(t => t && norm(t.status) !== "resolved");
    const counts = { uav: 0, reactive: 0, ordinary: 0, unknownUav: 0, ballistic: 0, kab: 0, fpv: 0, all: 0 };
    for (const t of threats) {
      const n = quantity(t), c = category(t);
      counts.all += n;
      if (c === "uav") {
        counts.uav += n;
        if (isReactive(t)) counts.reactive += n;
        else if (isOrdinaryUav(t)) counts.ordinary += n;
        else counts.unknownUav += n;
      } else if (c === "ballistic") counts.ballistic += n;
      else if (c === "kab") counts.kab += n;
      else if (c === "fpv") counts.fpv += n;
    }
    ui.uav.textContent = counts.uav;
    ui.uavSplit.textContent = `реакт. ${counts.reactive} · звич. ${counts.ordinary} · інші ${counts.unknownUav}`;
    ui.ballistic.textContent = counts.ballistic;
    ui.kab.textContent = counts.kab;
    ui.fpv.textContent = counts.fpv;
    ui.total.textContent = counts.all;
    ui.updated.textContent = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    ui.connection.textContent = "ПІДКЛЮЧЕНО";
    if (!alertsReceived) setAlertState("loading");
    const latest = threats.slice().sort((a, b) => Date.parse(b?.updatedAt || b?.updated_at || b?.createdAt || 0) - Date.parse(a?.updatedAt || a?.updated_at || a?.createdAt || 0)).slice(0, 30);
    ui.list.replaceChildren();
    if (!latest.length) {
      const empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = "Активних цілей зараз немає";
      ui.list.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const t of latest) {
      const c = category(t), type = c === "other" ? "other" : c;
      const row = document.createElement("div");
      row.className = "activity-item";
      row.style.setProperty("--item-accent", colors[type] || colors.other);
      const hasCoordinates = Number.isFinite(Number(t.lat)) && Number.isFinite(Number(t.lon));
      const threatId = String(t.id || `${t.type}-${t.lat}-${t.lon}`);
      if (hasCoordinates) {
        row.classList.add("is-locatable");
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.setAttribute("aria-label", `Показати на мапі: ${safeText(t.title, labels[type] || labels.other)}, ${location(t)}`);
        const locate = () => window.znFocusThreat?.(threatId);
        row.addEventListener("click", locate);
        row.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            locate();
          }
        });
      }
      const icon = document.createElement("span");
      icon.className = "activity-item__icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = icons[type] || icons.other;
      const main = document.createElement("span");
      main.className = "activity-item__main";
      const title = document.createElement("strong");
      title.textContent = safeText(t.title, labels[type] || labels.other) + (quantity(t) > 1 ? ` ×${quantity(t)}` : "");
      const place = document.createElement("small");
      place.textContent = location(t);
      main.append(title, place);
      const time = document.createElement("time");
      time.textContent = timeLabel(t);
      row.append(icon, main, time);
      fragment.append(row);
    }
    ui.list.append(fragment);
  }

  function setAlertState(state, active = false) {
    ui.alert.classList.toggle("is-clear", state === "clear");
    ui.alert.classList.toggle("is-error", state === "error");
    const text = state === "error" ? "API НЕДОСТУПНИЙ" : state === "loading" ? "ОЧІКУВАННЯ" : active ? "ТРИВОГИ" : "БЕЗ ТРИВОГ";
    ui.alert.lastChild.textContent = ` ${text}`;
  }

  window.addEventListener("zn-threats-update", e => {
    latestThreatSnapshot = Array.isArray(e.detail?.threats) ? e.detail.threats : [];
    renderThreats(latestThreatSnapshot);
    scanWatchedCity();
  });
  window.addEventListener("zn-threats-error", () => {
    threatError = true;
    if (!threatReceived) {
      ui.updated.textContent = "немає зв’язку";
      ui.connection.textContent = "API НЕДОСТУПНИЙ";
      ui.list.innerHTML = '<div class="activity-empty">Не вдалося завантажити активні цілі</div>';
    }
  });
  window.addEventListener("zn-alerts-update", e => {
    alertsReceived = true;
    const d = e.detail || {};
    const active = (Array.isArray(d.raions) && d.raions.length > 0) || (Array.isArray(d.oblasts) && d.oblasts.length > 0);
    setAlertState(active ? "active" : "clear", active);
  });
  window.addEventListener("zn-alerts-error", () => { if (!alertsReceived) setAlertState("error"); });

  function renderLaunches(items) {
    ui.launches.replaceChildren();
    if (!Array.isArray(items) || !items.length) {
      const empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = "Нових повідомлень про пуски немає";
      ui.launches.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items.slice(0, 4)) {
      const link = document.createElement("a");
      link.className = "activity-launch";
      link.href = item.url || "https://t.me/zaliznenebo";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const icon = document.createElement("span");
      icon.className = "activity-launch__icon";
      icon.textContent = "↗";
      const text = document.createElement("span");
      text.className = "activity-launch__text";
      const sourceText = item.text || "Повідомлення про БпЛА";
      text.textContent = item.origin?.label ? `Орієнтовно: ${item.origin.label} · ${sourceText}` : sourceText;
      const time = document.createElement("time");
      time.textContent = timeLabel({ updatedAt: item.datetime });
      link.append(icon, text, time);
      fragment.append(link);
    }
    ui.launches.append(fragment);
  }

  function initialBearing(from, to) {
    const radians = value => value * Math.PI / 180;
    const lat1 = radians(from.lat), lat2 = radians(to[1]);
    const deltaLon = radians(to[0] - from.lon);
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function removeLaunchMarker(key) {
    const marker = launchMarkers.get(key);
    if (marker) {
      if (marker._launchArrowRotateHandler) window.znMap?.off?.("rotate", marker._launchArrowRotateHandler);
      marker.remove();
    }
    launchMarkers.delete(key);
  }

  function updateLaunchMap(items) {
    const map = window.znMap;
    const maplibre = window.maplibregl;
    if (!map || !maplibre?.Marker) return;

    const now = Date.now();
    const active = new Map();
    for (const item of (Array.isArray(items) ? items : [])) {
      const origin = item?.origin;
      const published = Date.parse(item?.datetime || "");
      if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon)) ||
          !Number.isFinite(published) || now - published < 0 || now - published > LAUNCH_MARKER_MAX_AGE) continue;
      const key = String(item.url || `${item.datetime}-${origin.label}`);
      active.set(key, { item, origin });
    }

    for (const key of launchMarkers.keys()) if (!active.has(key)) removeLaunchMarker(key);

    for (const [key, { item, origin }] of active) {
      let marker = launchMarkers.get(key);
      if (marker) continue;

      const element = document.createElement("div");
      element.className = "launch-map-alert";
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-label", `Повідомлення про пуск БпЛА. Орієнтовний регіон: ${origin.label}. Стрілка показує загальний напрямок до України.`);
      element.title = `ПУСК БпЛА · орієнтовно: ${origin.label} · загальний напрямок до України`;

      const pulse = document.createElement("span");
      pulse.className = "launch-map-alert__pulse";
      const arrow = document.createElement("span");
      arrow.className = "launch-map-alert__arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "➤";
      const label = document.createElement("span");
      label.className = "launch-map-alert__label";
      label.textContent = `ПУСК БпЛА · ${origin.label}`;
      element.append(pulse, arrow, label);

      const updateArrow = () => {
        const bearing = initialBearing(origin, UKRAINE_CENTER);
        const rotation = (bearing - 90 - (map.getBearing?.() || 0) + 360) % 360;
        arrow.style.transform = `rotate(${rotation}deg)`;
      };
      updateArrow();
      const openSource = event => {
        event.preventDefault();
        event.stopPropagation();
        const url = String(item.url || "");
        if (/^https:\/\/t\.me\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      };
      element.addEventListener("click", openSource);
      element.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") openSource(event);
      });
      const mapMarker = new maplibre.Marker({ element, anchor: "center" })
        .setLngLat([Number(origin.lon), Number(origin.lat)])
        .addTo(map);
      mapMarker._launchArrowRotateHandler = updateArrow;
      map.on?.("rotate", updateArrow);
      launchMarkers.set(key, mapMarker);
    }
  }

  async function loadLaunches() {
    try {
      const response = await fetch("/api/telegram-launches", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = (await response.json()).items || [];
      renderLaunches(items);
      updateLaunchMap(items);
    } catch (error) {
      console.warn("Telegram launch feed error:", error);
      const empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = "Не вдалося завантажити дописи каналу";
      ui.launches.replaceChildren(empty);
      updateLaunchMap([]);
    }
  }
  loadLaunches();
  window.setInterval(loadLaunches, 15000);

  function renderTelegramPosts(items) {
    ui.telegramFeed.replaceChildren();
    const posts = (Array.isArray(items) ? items : []).slice().sort((a, b) => {
      const first = Date.parse(a?.datetime || "") || 0;
      const second = Date.parse(b?.datetime || "") || 0;
      return second - first;
    });
    if (!posts.length) {
      const empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = "У відкритій стрічці зараз немає доступних дописів";
      ui.telegramFeed.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      const link = document.createElement("a");
      link.className = "telegram-post";
      const url = String(post?.url || "");
      link.href = /^https:\/\/t\.me\//i.test(url) ? url : "https://t.me/zaliznenebo";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const text = document.createElement("span");
      text.className = "telegram-post__text";
      text.textContent = post?.text || "(порожній допис)";
      const time = document.createElement("time");
      time.textContent = timeLabel({ updatedAt: post?.datetime });
      const open = document.createElement("span");
      open.className = "telegram-post__open";
      open.textContent = "ВІДКРИТИ ↗";
      link.append(text, time, open);
      fragment.append(link);
    }
    ui.telegramFeed.append(fragment);
  }

  async function loadTelegramPosts() {
    if (telegramPostsLoading) return;
    telegramPostsLoading = true;
    ui.telegramRefresh.disabled = true;
    ui.telegramStatus.textContent = "Оновлюємо відкриту стрічку…";
    try {
      const response = await fetch("/api/telegram-news", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      renderTelegramPosts(items);
      ui.telegramStatus.textContent = `Доступних дописів: ${items.length} · оновлено ${new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    } catch (error) {
      console.warn("Telegram channel feed error:", error);
      ui.telegramStatus.textContent = "Не вдалося завантажити стрічку";
      const message = document.createElement("div");
      message.className = "activity-empty";
      message.textContent = "Перевірте з’єднання та натисніть «Оновити»";
      ui.telegramFeed.replaceChildren(message);
    } finally {
      telegramPostsLoading = false;
      ui.telegramRefresh.disabled = false;
    }
  }

  ui.telegramOpen.addEventListener("click", () => {
    ui.telegramModal.showModal();
    loadTelegramPosts();
    if (!telegramPostsTimer) telegramPostsTimer = window.setInterval(loadTelegramPosts, 30000);
  });
  ui.telegramClose.addEventListener("click", () => ui.telegramModal.close());
  ui.telegramRefresh.addEventListener("click", loadTelegramPosts);
  ui.telegramModal.addEventListener("click", event => {
    if (event.target === ui.telegramModal) ui.telegramModal.close();
  });
  ui.telegramModal.addEventListener("close", () => {
    if (telegramPostsTimer) window.clearInterval(telegramPostsTimer);
    telegramPostsTimer = null;
  });

  ui.cityWatchOpen.addEventListener("click", () => {
    ui.cityWatchSetup.hidden = !ui.cityWatchSetup.hidden;
    if (!ui.cityWatchSetup.hidden) {
      ui.cityWatchInput.value = watchedCity?.name || "";
      selectedWatchCity = watchedCity ? { ...watchedCity } : null;
      ui.cityWatchSelected.textContent = watchedCity ? `Обрано: ${watchedCity.name}${watchedCity.context ? ` · ${watchedCity.context}` : ""}` : "";
      ui.cityWatchSelected.hidden = !watchedCity;
      ui.cityWatchSave.disabled = !watchedCity;
      ui.cityWatchResults.replaceChildren();
      ui.cityWatchInput.focus();
    }
  });
  ui.cityWatchSearch.addEventListener("click", findWatchCities);
  ui.cityWatchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); findWatchCities(); }
  });
  ui.cityWatchSave.addEventListener("click", () => {
    if (!selectedWatchCity) return;
    watchedCity = { ...selectedWatchCity };
    try { localStorage.setItem("zn-watch-city", JSON.stringify(watchedCity)); }
    catch (error) { console.warn("Could not save selected city:", error); }
    ui.cityWatchSetup.hidden = true;
    window.znMap?.easeTo({ center: [watchedCity.lon, watchedCity.lat], zoom: Math.max(7, window.znMap.getZoom()), offset: [-Math.round((ui.panel.classList.contains("is-hidden") ? 0 : ui.panel.getBoundingClientRect().width) / 2), 0], duration: 950, essential: true });
    updateWatchedCityUI();
  });
  ui.cityWatchClear.addEventListener("click", () => {
    watchedCity = null;
    selectedWatchCity = null;
    try { localStorage.removeItem("zn-watch-city"); }
    catch (error) { console.warn("Could not remove saved city:", error); }
    ui.cityWatchSetup.hidden = true;
    updateWatchedCityUI();
  });
  ui.cityThreatShow.addEventListener("click", () => {
    const id = ui.cityThreatShow.dataset.threatId;
    if (id) window.znFocusThreat?.(id);
  });
  updateWatchedCityUI();
  window.setInterval(scanWatchedCity, 5000);

  function toggle(hidden) {
    ui.panel.classList.toggle("is-hidden", hidden);
    ui.tab.classList.toggle("is-visible", hidden);
  }
  ui.close.addEventListener("click", () => toggle(true));
  ui.tab.addEventListener("click", () => toggle(false));
  window.setTimeout(() => {
    if (!threatReceived && !threatError) {
      ui.updated.textContent = "очікування API";
      ui.connection.textContent = "ОЧІКУВАННЯ";
    }
  }, 9000);
})();
