// File upload widget for the application form.
function showUploadStatus(file, maxMb) {
  const status = document.getElementById("upload-status");
  if (file.size > maxMb * 1024 * 1024) {
    const message = gettext("%(name)s is too large. The limit is %(size)s MB.");
    status.textContent = interpolate(message, { name: file.name, size: maxMb }, true);
    return;
  }
  status.textContent = gettext("Uploading…");
}

function showSelected(count) {
  const label = ngettext("%s file selected", "%s files selected", count);
  return interpolate(label, [count]);
}
