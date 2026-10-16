# Synthetic video transport fixtures

No user data or credentials. `red.mp4` is a silent red 32×32 H.264 video;
`blue.avi` is a silent blue 32×32 MPEG-4 video. Both are 0.4 seconds at 5 fps.
They test original-byte transport and MIME/owner attribution, not gateway decoding.

Generated once with ffmpeg (not required to run the tests):

```sh
ffmpeg -f lavfi -i 'color=c=red:s=32x32:r=5' -t 0.4 -an -c:v libx264 -pix_fmt yuv420p red.mp4
ffmpeg -f lavfi -i 'color=c=blue:s=32x32:r=5' -t 0.4 -an -c:v mpeg4 blue.avi
```

The application never runs these commands or transcodes attachments. Tests copy
these tiny files into temporary allowed workspaces and intercept the final native
Google SDK fetch; they do not access a real provider.
