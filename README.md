# Tri-Wall Studio

Turn one picture into a whole three-wall LED room. You drop in the picture for the
centre wall, and the studio paints the left wall, the right wall and the two narrow
corner strips so the picture carries on around the room.

You don't need to know anything about AI or ComfyUI. The painting engine runs
quietly in the background and you never have to open it.

## Start it

1. Open the folder `D:\ComfyUI\triwall-studio`.
2. Double-click **`start_triwall_studio.bat`**.
3. Your browser opens **http://127.0.0.1:8790** by itself. Keep the black window
   open while you work, and close it when you're finished.

The first start can take a minute while it gets ready. If the painting engine isn't
running yet, the studio starts it for you.

> Opening `static\index.html` directly won't work. Always use the start script.

## Make a room

1. **Drop your picture onto the centre wall** in the 3D room, or click the wall to
   choose a file. The centre LED is 2:1 (twice as wide as it is tall). If your
   picture has a different shape, a bright frame shows what will be on the wall,
   and the faded parts are trimmed off.
2. Pick a style, if the choice is shown:
   - **Continue the scene**: one picture runs all the way around the room.
   - **Distinct views**: each side wall is its own view of the same world.
3. Press **Make my walls**. Claude looks at your picture and writes the scene, then
   the painter paints each wall. The walls light up on the 3D room as they finish.
   It usually takes **4–6 minutes**. The painter is shared, so sometimes you'll
   wait in line first; it starts by itself.

## Your result

- **Drag** the room to turn it. **Flat view** shows the walls laid out exactly as
  they sit on the LEDs.
- **Hover over any wall** and choose:
  - **Try another version** to repaint just that wall or corner. A corner is painted
    together with its wall in "Continue the scene", so they change together.
  - **View big** to see it full size. The ← and → keys step through the room.
- **Approve & make 4K** makes sharp 4K copies of the pieces you've approved.
- **Download** gives you a zip:
  - `2K/` has `left_1760x800.png`, `LR_160x800.png`, `centre_1920x960.png`,
    `RR_160x800.png` and `right_1760x800.png`.
  - `4K/` (after approving) has the same pieces at double size, for example
    `left_3520x1600.png`.
  - `room_layout.jpg` is a picture of the whole room.

Your past rooms are along the bottom of the page. Each one is saved in
`D:\ComfyUI\triwall-studio\projects\<name>\` with its pictures and a `settings.json`.

## Claude writing the scene (optional)

Claude needs an Anthropic API key. Set an environment variable called
`ANTHROPIC_API_KEY` on this computer (Windows: Start → "Edit environment variables
for your account" → New), then close and restart the studio.

Without a key the studio still works. It uses ready-made template words, which you
can edit.

## Advanced

The **Advanced** button opens the words the painter follows. Change any box and
press **Paint again with these words**. One rule matters: under "Things to keep
out", never list anything you can see near the left or right edge of your picture.
It confuses the painter and spoils the wall.

## If something goes wrong

- **"Start Tri-Wall Studio first"**: run `start_triwall_studio.bat`.
- **It says "needs uv"**: install uv from https://docs.astral.sh/uv/ and start again.
- **A wall looks wrong**: press **Try another version** on that wall. Every try is
  different.
- Logs are in `D:\ComfyUI\triwall-studio\logs\`.
