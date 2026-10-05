# Tri-Wall Studio

Turn one picture into a whole three-wall LED room. You drop in the picture for the
centre wall, and the studio paints the left wall, the right wall and the two narrow
corner strips so the picture carries on around the room.

You don't need to know anything about AI or ComfyUI. The painting engine runs
quietly in the background and you never have to open it.

## Start it

The studio lives in the `studio` folder of the Tri-Wall Console. The easiest way in is
the orange **Tri-Wall Studio →** button at the top of the Console: it opens the studio,
and starts it first if it isn't running. **Tri-Wall Console →** at the top of the studio
takes you back.

To start it on its own:

1. Open the `studio` folder inside the triwallconsole folder.
2. Double-click **`start_triwall_studio.bat`**.
3. Your browser opens **http://127.0.0.1:8790** by itself. Keep the black window
   open while you work, and close it when you're finished.

The first start can take a minute while it gets ready. If the painting engine isn't
running yet, the studio starts it for you. Double-clicking the start file again while
the studio is running just opens it in your browser.

> Opening `static\index.html` directly won't work. Always use the start file.

## Make a room

1. **Drop your picture onto the centre wall** in the 3D room, or click the wall to
   choose a file. The centre LED is 2:1 (twice as wide as it is tall). If your
   picture has a different shape, a bright frame shows what will be on the wall,
   and the faded parts are trimmed off.
2. Answer **"What's in your picture?"**: Room, Street & town, City & water, Nature
   or Sky only, and whether it's a **Cartoon** or a **Photo**. The studio guesses
   cartoon or photo for you; just check it. This picks the right words for the
   painter, which matters most when Claude isn't set up.
3. Pick a style:
   - **Continue the scene**: one picture runs all the way around the room.
   - **Distinct views**: each side wall is its own view of the same world, joined
     to the centre by the corners.
4. Press **Make my walls**. The painter paints each wall, and the walls light up in
   the room as they finish. It usually takes **4–6 minutes**. The painter is shared
   with other work, so sometimes you'll wait in line first ("Waiting for the painter
   (another job is running)"). It starts by itself.

While a room is painting you can open any of your other rooms. A "Painting: …"
label at the top shows what's running; click it to go back. You'll get a message
when it's done.

## Three ways to look at your room

- **3D room**: the room you're building. Drag to turn it.
- **Flat view**: the walls laid out exactly as they sit on the LEDs, top-aligned,
  with the centre taller than the side walls.
- **Real theatre**: your pictures on the actual theatre model, seen from where the
  audience sits. Drag to look around, scroll to move, **Reset view** to go back.
  Click a screen to see it big.

## Your result

- **Hover over any wall** and choose:
  - **Try another version** to repaint just that wall or corner. In "Continue the
    scene" a corner is painted together with its wall, so they change together.
  - **View big** to see it full size. The ← and → keys step through the room.
- **Approve & make 4K** makes sharp 4K copies (double size) of the pieces you see.
  It takes about a minute once the painter is free. Repainting a wall afterwards
  removes the old 4K files, so approve again when you're happy.
- **Download** gives you a zip:
  - `2K/`: `left_1760x800.png`, `LR_160x800.png`, `centre_1920x960.png`,
    `RR_160x800.png` and `right_1760x800.png`.
  - `4K/` (after approving): the same pieces at double size, for example
    `left_3520x1600.png` and `centre_3840x1920.png`.
  - `room_layout.jpg`: a picture of the whole room.

## Where your rooms are saved

Your rooms are along the bottom of the page. Each one is a folder in
`studio\projects\<name>\` (never committed to git):

- `centre_original.png` is your picture, unchanged;
- `2K\` and `4K\` hold the pieces;
- `room_layout.jpg` is the whole room;
- `settings.json` has the words and seeds used.

Settings for whoever runs it (all optional): `TRIWALL_STUDIO_PORT` (default 8790),
`TRIWALL_STUDIO_PROJECTS` (another rooms folder), `TRIWALL_CONSOLE_URL` (where the
Console button goes, default http://localhost:8934).

## Claude writing the scene (optional)

With an Anthropic API key, Claude looks at your picture and writes the words for the
painter. To set it up:

1. Press Start, type **environment variables**, and open "Edit environment
   variables for your account".
2. Under "User variables" press **New**. Name: `ANTHROPIC_API_KEY`. Value: your key.
3. Press OK, then close the Tri-Wall Studio window and start it again.

The top of the page then says "Claude writes the scene". The key stays on this
computer and is never saved by the studio. Without a key the studio still works,
using ready-made words for the kind of picture you chose.

## Advanced

The **Advanced** button opens the words the painter follows. Change any box and
press **Paint again with these words**. One rule matters: under "Things to keep
out", never list anything you can see near the left or right edge of your picture.
It confuses the painter and spoils the wall.

## If something goes wrong

- **"Start Tri-Wall Studio first"**: double-click `start_triwall_studio.bat`.
- **It says "needs uv"**: install uv from https://docs.astral.sh/uv/ and start again.
- **A wall looks wrong**: press **Try another version** on that wall. Every try is
  different.
- **Streets that run off into the distance, or made-up writing on signs**: these come
  from the picture's own perspective. Try another version, check that "Street & town"
  is picked, or set up Claude.
- Logs are in `D:\ComfyUI\triwall-studio\logs\`.
