let pickerSequence = 0;

const normalizeSearch = (value) => String(value ?? "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();

const dialingCode = (country) => `+${String(country.dialCode).replace(/^\+/, "")}`;

/** Searchable country selection. Only a committed option changes the value. */
export function createCountryPicker({
  root,
  button,
  search,
  list,
  status,
  countries,
  value = "GB",
  onChange = () => {},
}) {
  const panel = root?.querySelector(".country-popover");
  if (!root || !button || !search || !list || !status || !panel || !countries?.length) {
    throw new TypeError("Country picker requires its controls and a country list.");
  }

  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const prefix = `country-picker-${++pickerSequence}`;
  const entries = countries.map((country) => ({
    country,
    code: normalizeSearch(country.code),
    name: normalizeSearch(country.name),
    dial: dialingCode(country).replace(/\D/g, ""),
  }));
  let selected = countries.find((country) => country.code === value) || countries[0];
  let filtered = [];
  let options = [];
  let activeIndex = -1;
  let isOpen = false;
  let isExplicitlyDisabled = false;

  panel.id ||= `${prefix}-popover`;
  search.id ||= `${prefix}-search`;
  list.id ||= `${prefix}-list`;
  status.id ||= `${prefix}-status`;
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  if (!panel.hasAttribute("aria-label") && !panel.hasAttribute("aria-labelledby")) {
    panel.setAttribute("aria-label", "Choose country code");
  }
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", "false");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-controls", list.id);
  search.setAttribute("aria-expanded", "false");
  search.placeholder = "Search country or code";
  if (!search.hasAttribute("aria-label") && !search.hasAttribute("aria-labelledby")) {
    search.setAttribute("aria-label", "Search country or calling code");
  }
  list.setAttribute("role", "listbox");
  // Focus stays on the combobox; prevent the scroller becoming a native Tab stop.
  list.tabIndex = -1;
  if (!list.hasAttribute("aria-label") && !list.hasAttribute("aria-labelledby")) {
    list.setAttribute("aria-label", "Countries");
  }
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");

  function disabled() {
    return isExplicitlyDisabled || button.disabled || button.matches(":disabled");
  }

  function updateButton() {
    button.textContent = `${selected.code} ${dialingCode(selected)}`;
    button.setAttribute("aria-label", `Country code: ${selected.name}, ${dialingCode(selected)}`);
  }

  function positionPanel() {
    if (!isOpen) return;
    const anchor = root.closest(".phone-controls") || root;
    const rect = anchor.getBoundingClientRect();
    const viewport = view.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (viewport?.height || view.innerHeight);
    const margin = 16; // Includes the gap to the control and a viewport edge inset.
    const below = Math.max(0, viewportBottom - rect.bottom - margin);
    const above = Math.max(0, rect.top - viewportTop - margin);
    const placeAbove = below < 260 && above > below;
    panel.dataset.placement = placeAbove ? "above" : "below";
    panel.style.maxHeight = `${Math.floor(Math.min(400, placeAbove ? above : below))}px`;
    scrollActiveOption();
  }

  function scrollActiveOption() {
    const option = options[activeIndex];
    if (!isOpen || !option) return;
    // Adjust only the options scroller; scrollIntoView can also move the page.
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const top = listRect.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (optionRect.top < top) list.scrollTop -= top - optionRect.top;
    else if (optionRect.bottom > bottom) list.scrollTop += optionRect.bottom - bottom;
  }

  function setActive(index) {
    activeIndex = filtered.length ? Math.max(0, Math.min(index, filtered.length - 1)) : -1;
    options.forEach((option, optionIndex) => {
      const active = optionIndex === activeIndex;
      option.dataset.active = String(active);
      option.classList.toggle("is-active", active);
    });
    if (isOpen && activeIndex >= 0) {
      search.setAttribute("aria-activedescendant", options[activeIndex].id);
      scrollActiveOption();
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  }

  function render() {
    const query = normalizeSearch(search.value);
    const digits = query.replace(/[\s()+.-]/g, "");
    const isDialQuery = /^\d+$/.test(digits);
    filtered = entries.map((entry, index) => {
      const exact = entry.name === query
        || entry.code === query
        || (query === "uk" && entry.code === "gb")
        || (isDialQuery && entry.dial === digits);
      const prefix = entry.name.startsWith(query)
        || entry.code.startsWith(query)
        || (isDialQuery && entry.dial.startsWith(digits));
      const substring = entry.name.includes(query)
        || entry.code.includes(query)
        || (isDialQuery && entry.dial.includes(digits));
      return { entry, index, rank: !query || exact ? 0 : prefix ? 1 : substring ? 2 : 3 };
    })
      .filter((match) => match.rank < 3)
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((match) => match.entry.country);

    const fragment = doc.createDocumentFragment();
    options = filtered.map((country) => {
      const option = doc.createElement("div");
      option.id = `${list.id}-${country.code}`;
      option.className = "country-option";
      option.dataset.countryCode = country.code;
      option.setAttribute("role", "option");
      option.setAttribute("aria-label", `${country.name}, ${dialingCode(country)}`);
      option.setAttribute("aria-selected", String(country.code === selected.code));
      const name = doc.createElement("span");
      name.className = "country-option-name";
      name.textContent = country.name;
      const dial = doc.createElement("span");
      dial.className = "country-option-code";
      dial.textContent = dialingCode(country);
      option.append(name, dial);
      fragment.append(option);
      return option;
    });
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    status.hidden = filtered.length > 0;
    status.textContent = filtered.length ? "" : "No countries found. Try a country name or calling code.";
    const selectedIndex = filtered.findIndex((country) => country.code === selected.code);
    setActive(!query && selectedIndex >= 0 ? selectedIndex : 0);
  }

  function outsidePointer(event) {
    if (!root.contains(event.target)) closePanel(false);
  }

  function ancestorScroll(event) {
    const target = event.target;
    if (panel.contains(target)) return;
    if (target === doc || target?.contains?.(root)) positionPanel();
  }

  function listenToViewport(add) {
    const method = add ? "addEventListener" : "removeEventListener";
    view[method]("resize", positionPanel);
    view.visualViewport?.[method]("resize", positionPanel);
    view.visualViewport?.[method]("scroll", positionPanel);
    doc[method]("pointerdown", outsidePointer, true);
    doc[method]("scroll", ancestorScroll, true);
  }

  function openPanel(initialQuery = "") {
    if (disabled()) return;
    if (!isOpen) {
      isOpen = true;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      search.setAttribute("aria-expanded", "true");
      listenToViewport(true);
    }
    search.value = initialQuery;
    positionPanel();
    render();
    search.focus({ preventScroll: true });
    search.setSelectionRange(search.value.length, search.value.length);
  }

  function closePanel(restoreFocus) {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    listenToViewport(false);
    if (restoreFocus && !disabled()) button.focus({ preventScroll: true });
  }

  function commit(country) {
    if (!country || disabled()) return;
    const changed = country.code !== selected.code;
    selected = country;
    updateButton();
    closePanel(true);
    if (changed) onChange(selected);
  }

  button.addEventListener("click", () => {
    if (disabled()) return;
    if (isOpen) closePanel(false);
    else openPanel();
  });

  button.addEventListener("keydown", (event) => {
    if (disabled() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openPanel();
    } else if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closePanel(true);
    } else if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      openPanel(event.key);
    }
  });

  search.addEventListener("input", () => {
    if (!isOpen || disabled()) return;
    render();
  });

  search.addEventListener("keydown", (event) => {
    if (!isOpen || disabled() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(filtered.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        commit(filtered[activeIndex]);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
        break;
      default:
        // Tab and text editing retain their native browser behavior.
        break;
    }
  });

  function optionFromEvent(event) {
    const option = event.target.closest?.(".country-option");
    return option && list.contains(option) ? option : null;
  }

  list.addEventListener("mousedown", (event) => {
    if (optionFromEvent(event)) event.preventDefault();
  });

  list.addEventListener("click", (event) => {
    if (!isOpen || disabled()) return;
    const option = optionFromEvent(event);
    if (option) commit(filtered.find((country) => country.code === option.dataset.countryCode));
  });

  root.addEventListener("focusout", (event) => {
    if (!isOpen) return;
    if (event.relatedTarget) {
      if (!root.contains(event.relatedTarget)) closePanel(false);
      return;
    }
    // Null relatedTarget occurs when focus leaves the document or controls hide.
    view.setTimeout(() => {
      if (isOpen && !root.contains(doc.activeElement)) closePanel(false);
    }, 0);
  });

  // A form may disable its entire fieldset while saving without calling our API.
  if (view.MutationObserver) {
    const observer = new view.MutationObserver(() => {
      if (disabled()) closePanel(false);
    });
    observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
    const fieldset = root.closest("fieldset");
    if (fieldset) observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
  }

  updateButton();
  return {
    get value() { return selected.code; },
    close() { closePanel(panel.contains(doc.activeElement)); },
    setDisabled(value) {
      isExplicitlyDisabled = Boolean(value);
      button.disabled = isExplicitlyDisabled;
      search.disabled = isExplicitlyDisabled;
      if (isExplicitlyDisabled) closePanel(false);
    },
  };
}
