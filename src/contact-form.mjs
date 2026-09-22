import { decode as decodePunycode, encode as encodePunycode } from "../vendor/punycode/punycode.mjs";
import { createCountryPicker } from "./country-picker.mjs";

const phoneExamples = { GB: "07400 123456", IN: "98765 43210", US: "(202) 555-0123", CA: "(416) 555-0123" };
const phoneCharacters = /^\+?[0-9\s()-]*$/;
const digits = value => value.replace(/\D/g, "");
const unsafeEmailCharacters = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}]/u;
const unavailable = "Phone validation could not load. Reload this page and try again.";

// Practical single-address web-form syntax: an ASCII dot-atom local part and
// a public-style DNS domain (including international names via IDNA). This
// checks format only, never mailbox ownership, DNS, or deliverability.
export function validateEmail(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Enter your email address.");
  const value = raw.trim();
  if (/\s/u.test(value) || unsafeEmailCharacters.test(value)) {
    throw new Error("Remove spaces, line breaks or invisible characters from your email address.");
  }
  if (value.length > 254) throw new Error("Your email address must be 254 characters or fewer.");
  const parts = value.split("@");
  if (parts.length !== 2) throw new Error("Enter one email address with a single @, such as you@example.com.");
  const [local, domain] = parts;
  if (!local) throw new Error("Enter the part of your email address before @.");
  if (!domain) throw new Error("Enter the domain after @, such as example.com.");
  if (local.length > 64) throw new Error("The part before @ must be 64 characters or fewer.");
  if (!/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/i.test(local)) {
    throw new Error("Check the part before @. Use letters, numbers and valid email symbols; dots cannot be first, last or repeated.");
  }
  const domainMessage = "Enter a valid email domain, such as example.com or company.co.uk.";
  // Restrict domain syntax before URL parsing so URL paths, ports, credentials,
  // percent escapes and IP-address normalization cannot turn input into email.
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(domain)) throw new Error(domainMessage);
  let asciiDomain;
  try { asciiDomain = new URL(`https://${domain}`).hostname; }
  catch { throw new Error(domainMessage); }
  const labels = asciiDomain.split(".");
  const tld = labels.at(-1);
  // Browser URL parsers differ on malformed ACE labels. Decode and verify
  // each one explicitly so an encoded control/hidden character cannot pass.
  try {
    for (const label of labels.filter(item => item.startsWith("xn--"))) {
      const decoded = decodePunycode(label.slice(4));
      if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*$/u.test(decoded) ||
          decoded.endsWith("-") || unsafeEmailCharacters.test(decoded) || !/[^\x00-\x7f]/.test(decoded) ||
          `xn--${encodePunycode(decoded)}` !== label ||
          new URL(`https://${decoded}.example`).hostname !== `${label}.example`) {
        throw new Error(domainMessage);
      }
    }
  } catch { throw new Error(domainMessage); }
  if (labels.length < 2 || labels.some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/i.test(tld)) {
    throw new Error(domainMessage);
  }
  const normalized = `${local.toLowerCase()}@${asciiDomain.toLowerCase()}`;
  if (normalized.length > 254) throw new Error("Your email address is too long. Use 254 characters or fewer, including the encoded domain.");
  // Keep the established case-insensitive contact identity. Preserve dots and
  // plus tags: provider-specific rewriting could associate another contact.
  return normalized;
}

export function phoneEditError(raw, country, api) {
  if (!phoneCharacters.test(raw.trim())) return "Use numbers only, with an optional +, spaces, brackets or hyphens.";
  const lengthError = api?.validatePhoneNumberLength?.(raw, country);
  // Dial-out/carrier prefixes can exceed 15 raw digits. E.164's limit applies
  // to the canonical number, not the user's national dialing representation.
  const canonical = digits(raw).length > 15
    ? api?.parsePhoneNumberFromString?.(raw, { defaultCountry: country, extract: false })?.number
    : raw;
  if (digits(canonical || raw).length > 15 || lengthError === "TOO_LONG") {
    return "This number is too long for the selected country. Check the country code and number.";
  }
  return "";
}

export function validatePhone(raw, country, api) {
  const value = raw.trim();
  if (!value) throw new Error("Enter your phone number.");
  if (!api?.parsePhoneNumberFromString || !api?.getCountries || !api?.getCountryCallingCode || !api?.validatePhoneNumberLength) {
    throw new Error(unavailable);
  }
  if (!api.getCountries().includes(country)) throw new Error("Choose your country code.");
  const editError = phoneEditError(value, country, api);
  if (editError) throw new Error(editError);
  const phone = api.parsePhoneNumberFromString(value, { defaultCountry: country, extract: false });
  if (phone && (phone.countryCallingCode !== api.getCountryCallingCode(country) ||
      (phone.country && phone.country !== country))) {
    throw new Error("Choose the country that matches your phone number.");
  }
  if (api.validatePhoneNumberLength(value, country) === "TOO_SHORT") {
    throw new Error("This phone number is too short. Please enter the complete number.");
  }
  if (!phone?.isValid() || phone.ext) throw new Error("Enter a valid phone number for the selected country.");
  return phone.number;
}

export function createContactForm({ emailInput, phoneInput, emailError, phoneError, phoneHint,
  countryRoot, countryButton, countrySearch, countryList, countryStatus,
  api = globalThis.libphonenumber, onEdit = () => {}, onValidityChange = () => {} }) {
  const touched = { email: false, phone: false };
  let rejectedPhoneEdit = "";
  let rejectedEmailEdit = "";
  let lastAcceptedPhone = phoneInput.value;
  let country = "GB";
  let countries = [{ code: "GB", name: "United Kingdom", dialCode: "44" }];
  if (api?.getCountries && api?.getCountryCallingCode) {
    let names;
    try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* ISO labels remain usable. */ }
    countries = api.getCountries().map(code => ({ code, name: names?.of(code) || code,
      dialCode: api.getCountryCallingCode(code) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  function show(field, message) {
    const input = field === "email" ? emailInput : phoneInput;
    const error = field === "email" ? emailError : phoneError;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    error.textContent = message;
    error.hidden = !message;
  }

  function read() {
    const contacts = {}, errors = {};
    try {
      if (rejectedEmailEdit) throw new Error(rejectedEmailEdit);
      contacts.email = validateEmail(emailInput.value);
    }
    catch (error) { errors.email = error.message; }
    try {
      if (rejectedPhoneEdit) throw new Error(rejectedPhoneEdit);
      contacts.phone = validatePhone(phoneInput.value, country, api);
    } catch (error) { errors.phone = error.message; }
    return { contacts, errors, valid: !Object.keys(errors).length };
  }

  function refresh() {
    const state = read();
    emailInput.setCustomValidity(state.errors.email || "");
    for (const field of ["email", "phone"]) {
      if (touched[field] || !state.errors[field]) show(field, state.errors[field] || "");
    }
    onValidityChange(state.valid);
    return state;
  }

  function updateHint() {
    const selected = countries.find(item => item.code === country);
    const example = phoneExamples[country];
    phoneInput.placeholder = example || "Phone number";
    phoneHint.textContent = `${selected.name} (+${selected.dialCode})${example ? ` · e.g. ${example}` : " · Enter your national phone number."}`;
  }

  const picker = createCountryPicker({ root: countryRoot, button: countryButton, search: countrySearch,
    list: countryList, status: countryStatus, countries, value: country,
    onChange(selected) {
      country = selected.code;
      rejectedPhoneEdit = "";
      // Retain the complete number on country changes; never shorten it to fit.
      lastAcceptedPhone = phoneInput.value;
      if (phoneInput.value) touched.phone = true;
      updateHint();
      onEdit();
      refresh();
    },
  });

  function proposedValue(text) {
    const start = phoneInput.selectionStart ?? phoneInput.value.length;
    const end = phoneInput.selectionEnd ?? start;
    return phoneInput.value.slice(0, start) + text + phoneInput.value.slice(end);
  }

  function rejectEdit(message) {
    rejectedPhoneEdit = message + " The entry was not added.";
    touched.phone = true;
    onEdit();
    refresh();
  }

  phoneInput.addEventListener("beforeinput", event => {
    if (event.isComposing || !event.inputType?.startsWith("insert") || typeof event.data !== "string") return;
    const error = phoneEditError(proposedValue(event.data), country, api);
    if (error) {
      event.preventDefault();
      rejectEdit(error);
    }
  });
  phoneInput.addEventListener("paste", event => {
    if (!event.clipboardData) return;
    const error = phoneEditError(proposedValue(event.clipboardData.getData("text")), country, api);
    if (error) {
      event.preventDefault();
      rejectEdit(error);
    }
  });
  phoneInput.addEventListener("input", event => {
    if (event.isComposing) return;
    const error = phoneEditError(phoneInput.value, country, api);
    const removing = event.inputType?.startsWith("delete") || phoneInput.value.length < lastAcceptedPhone.length;
    if (error && !removing) {
      phoneInput.value = lastAcceptedPhone;
      rejectEdit(error);
      return;
    }
    lastAcceptedPhone = phoneInput.value;
    rejectedPhoneEdit = "";
    // Show invalid completed-length numbers immediately, without scolding a
    // user for an untouched partial number that is still too short.
    if (phoneInput.value && api?.validatePhoneNumberLength?.(phoneInput.value, country) === undefined) touched.phone = true;
    onEdit();
    refresh();
  });
  phoneInput.addEventListener("compositionend", () => phoneInput.dispatchEvent(new Event("input", { bubbles: true })));
  phoneInput.addEventListener("blur", () => {
    touched.phone = true;
    const state = refresh();
    if (!state.errors.phone) {
      const parsed = api.parsePhoneNumberFromString(state.contacts.phone);
      phoneInput.value = parsed.formatNational();
      lastAcceptedPhone = phoneInput.value;
    }
  });
  function rejectUnsafeEmailInsertion(event, text) {
    // type=email strips line breaks before "input". Catch raw inserted text so
    // e.g. "first\nlast@example.com" is not silently changed to another address.
    if (!unsafeEmailCharacters.test(text)) return;
    event.preventDefault();
    rejectedEmailEdit = "The entry was not added. Enter one email address without line breaks or invisible characters.";
    touched.email = true;
    onEdit();
    refresh();
  }
  emailInput.addEventListener("beforeinput", event => {
    if (event.isComposing || !event.inputType?.startsWith("insert") || typeof event.data !== "string") return;
    rejectUnsafeEmailInsertion(event, event.data);
  });
  emailInput.addEventListener("paste", event => {
    touched.email = true;
    if (event.clipboardData) rejectUnsafeEmailInsertion(event, event.clipboardData.getData("text"));
  });
  emailInput.addEventListener("drop", event => {
    touched.email = true;
    if (event.dataTransfer) rejectUnsafeEmailInsertion(event, event.dataTransfer.getData("text"));
  });
  emailInput.addEventListener("input", event => {
    rejectedEmailEdit = "";
    onEdit();
    if (event.isComposing) { onValidityChange(false); return; }
    if (emailInput.value.length > 254 || event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") touched.email = true;
    refresh();
  });
  emailInput.addEventListener("compositionend", () => { onEdit(); refresh(); });
  emailInput.addEventListener("blur", () => {
    touched.email = true;
    emailInput.value = emailInput.value.trim();
    const state = refresh();
    if (!state.errors.email) emailInput.value = state.contacts.email;
  });

  updateHint();
  refresh();
  return {
    validate() {
      touched.email = touched.phone = true;
      const state = refresh();
      if (!state.valid) (state.errors.email ? emailInput : phoneInput).focus();
      return state.valid ? state.contacts : null;
    },
    refresh,
    closeCountryPicker: picker.close,
  };
}
