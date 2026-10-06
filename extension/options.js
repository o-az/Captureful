const DEFAULT_SETTINGS = { confirmArea: false, autoStop: true, scale: 0 }

/** @param {string} id */
const input = (id) =>
  /** @type {HTMLInputElement} */ (document.getElementById(id))

const load = async () => {
  const { settings } = await browser.storage.local.get('settings')
  const current = { ...DEFAULT_SETTINGS, ...settings }
  input('confirmArea').checked = current.confirmArea
  input('autoStop').checked = current.autoStop
  input('scale').value = String(current.scale)
}

const save = () =>
  browser.storage.local.set({
    settings: {
      confirmArea: input('confirmArea').checked,
      autoStop: input('autoStop').checked,
      scale: Number(input('scale').value),
    },
  })

for (const id of ['confirmArea', 'autoStop', 'scale'])
  input(id).addEventListener('change', save)

input('forget').addEventListener('click', async () => {
  await browser.storage.local.remove('areas')
  input('status').textContent = 'Forgotten'
})

void load()
