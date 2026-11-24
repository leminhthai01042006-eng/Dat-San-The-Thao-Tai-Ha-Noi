function isValidImageUrl(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;

  const url = value.trim();
  return url.length <= 500 && /^https?:\/\//i.test(url) && URL.canParse(url);
}

module.exports = { isValidImageUrl };
