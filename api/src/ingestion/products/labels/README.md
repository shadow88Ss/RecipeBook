# Manufacturer label files (Layer 12B.2a)

One `<brand>-<product>.label.json` per product, transcribed from the physical
pack by the operator (format: `../examples/SYNTHETIC-EXAMPLE.label.json`,
`docs/40_Development_Environment.md` §12).

- Transcribe exactly what the label states. Do not estimate, convert kJ to
  kcal, compute energy, or copy values from Open Food Facts, FatSecret, USDA or
  any other source.
- No personal data in any field (`observed_at` is a shop name, not a person).
- Photos stay on your own device: image files are ignored here by `.gitignore`.
- Commit a file only after its dry run has been reviewed and it was published,
  so the repository records exactly what was entered.
