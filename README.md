# an-deployment-prompts

## Lulu Scrapbook PDF

1. In the app, sign in and open `Scrapbook`.
2. Click `Download Archive`.
3. Build the Lulu interior PDF:

```bash
npm run scrapbook:pdf -- --archive ~/Downloads/an-deployment-scrapbook-archive-YYYY-MM-DD.json
```

The output is written to:

```text
dist/A-N-Deployment-Scrapbook-interior-lulu-6x9.pdf
```

This is an interior file only. Lulu requires the cover as a separate integrated cover spread after the interior page count is known.

The builder uses Lulu's 6 x 9 interior setup:

- PDF page size: `6.25in x 9.25in`
- Trim size: `6in x 9in`
- Bleed: `0.125in`
- No browser headers, footers, trim lines, or margin lines
- Local image copies in `dist/scrapbook-lulu/assets`
