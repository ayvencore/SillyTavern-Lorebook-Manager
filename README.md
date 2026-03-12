# Lorebook Manager

`Lorebook Manager` is a third-party SillyTavern extension that adds a visual manager for lorebooks/world info files.

# Disclaimer
I'm not versed in TypeScript, but I do have some experiences in building websites, and extending features to make them work in my favour. This extension, as a result IS vibe coded. It has not yet been tested on mobile. This is just the first iteration. Feedback, contribution, and feature requests are welcomed!

## What it adds

- A `Manager` button inside the built-in World Info drawer
- Named folders and nested subfolders for organizing lorebooks
- A card-based browser with searchable lorebooks
- Optional cover images for each lorebook
- Quick actions to open, rename, move, import, create, and delete lorebooks

## How it stores data

- Folder tree state is stored in SillyTavern extension settings under `lorebookManager`
- Per-lorebook manager data is stored inside each lorebook JSON under:

```json
{
  "extensions": {
    "lorebook_manager": {
      "bookId": "uuid",
      "folderId": "uuid",
      "coverPath": "user/images/lorebook-manager/example-cover.png"
    }
  }
}
```

This keeps covers and folder assignment attached to the lorebook instead of a separate sidecar file.

## Install

Place this extension folder inside your SillyTavern third-party extensions directory:

```text
SillyTavern/data/<your-user>/extensions/
```

Or install it with SillyTavern's built-in extension installer from the repository URL.

```text
SillyTavern/data/<your-user>/extensions/
```

## Notes

- Cover images are uploaded through SillyTavern's normal user image storage.
- Renaming from the manager uses SillyTavern's built-in rename flow so it behaves like the core lorebook editor.
