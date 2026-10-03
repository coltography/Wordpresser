# Wordpresser

Write in Obsidian, publish to your **self-hosted WordPress** site (WordPress.org, not WordPress.com).

## Features

- One-click publish or update from the ribbon, as a draft or a live post
- Properties-driven posts: `title`, `excerpt`, `slug`, `tags`, `categories`, `featured_image`
- Category and tag pickers with existing terms, post counts and create-as-you-type
- Featured image picker (uploaded straight to your media library)
- Images upload automatically; identical images are reused instead of duplicated
- Captions and optional click-to-expand (lightbox) per image
- Side-by-side images, text alignment, external links open in a new tab
- Optional per-post folders so each post's images live with the post
- Preview button for published posts and drafts
- Image rename, size presets and captions from the hover controls or right-click menu
- Note title, note name and folder name stay in sync both ways

## Setup

1. In WordPress: **Users → Profile → Application Passwords**, create one named "Obsidian".
2. In Obsidian: **Settings → Wordpresser**. Enter your site URL and username, then pick or create a secret for the application password and press **Test**.
3. Create a note. The properties are added automatically (or use the ribbon button), write your post, then press the send icon.

## Writing posts

| You write | Result |
| --- | --- |
| `![[photo.png]]` | Image, uploaded on publish |
| `![[photo.png\|My caption]]` | Image with a caption |
| `![[photo.png\|My caption\|300]]` | Caption and a width of 300px |
| `![[photo.png\|expand]]` / `\|noexpand` | Force click-to-expand on or off for this image |
| Right-click an image → Small / Medium / Original | Sets the width (sizes are configurable in settings) |
| Two images on one line | Shown side by side |
| Right-click → Align text | Left, center or right alignment (stored as an invisible marker at the end of the line) |

Hover an image in the editor for an **Expand** checkbox and a **Caption** button, or right-click it.

## Privacy and network use

- The plugin talks **only to the WordPress site you configure**, using its REST API. There is no telemetry, analytics or advertising.
- Your application password is stored with Obsidian's secure storage on your device, not in `data.json` or your vault. It is never sent anywhere except your own site (HTTP Basic authentication).
- Local images and the featured image you choose are uploaded to your site's media library when you publish.

## Notes for the curious

- Per-post folders and "reuse existing images" adjust how Obsidian names and saves dropped attachments. Both can be turned off in settings.
- The file explorer options (hide images, sort notes first) are done with CSS.

## Compatibility

Requires Obsidian 1.11.4 or newer (for secure storage). Works on desktop and mobile. Image reuse, per-post folders and the editor image controls depend on Obsidian internals and may need updates when Obsidian changes.

## Development

```
npm install
npm run dev     # watch
npm run build   # type-check and bundle main.js
```

## License

MIT
