const PRESETS = [
  ['auto', 'Current window', 0, 0], ['1920x1080', 'Desktop 1920 × 1080', 1920, 1080], ['1440x900', 'Laptop 1440 × 900', 1440, 900],
  ['1280x800', 'Laptop 1280 × 800', 1280, 800], ['1024x768', 'Small 1024 × 768', 1024, 768], ['768x1024', 'Tablet 768 × 1024', 768, 1024],
  ['390x844', 'Mobile 390 × 844', 390, 844], ['custom', 'Custom…', 0, 0]
];
const DEFAULTS = { includeHeader: true, resolution: { preset: 'auto', width: 1440, height: 900 } };

const $ = (id) => document.getElementById(id);
const preset = $('preset');
for (const [value, label] of PRESETS) preset.add(new Option(label, value));

let savedTimer;
function flash() {
  $('saved').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

function sync(res) {
  preset.value = PRESETS.some((p) => p[0] === res.preset) ? res.preset : 'auto';
  $('width').value = res.width;
  $('height').value = res.height;
  const custom = preset.value === 'custom';
  $('width').disabled = $('height').disabled = !custom;
  $('sizeRow').style.display = preset.value === 'auto' ? 'none' : 'flex';
}

function readResolution() {
  if (preset.value === 'custom') {
    return { preset: 'custom', width: Number($('width').value) || 1440, height: Number($('height').value) || 900 };
  }
  const p = PRESETS.find((x) => x[0] === preset.value);
  if (preset.value === 'auto') return { preset: 'auto', width: Number($('width').value) || 1440, height: Number($('height').value) || 900 };
  return { preset: preset.value, width: p[2], height: p[3] };
}

async function save() {
  const resolution = readResolution();
  sync(resolution);
  await chrome.storage.local.set({ includeHeader: $('includeHeader').checked, resolution });
  flash();
}

chrome.storage.local.get(DEFAULTS).then((prefs) => {
  $('includeHeader').checked = prefs.includeHeader;
  sync(prefs.resolution);
});
$('includeHeader').onchange = save;
preset.onchange = save;
$('width').onchange = $('height').onchange = save;
