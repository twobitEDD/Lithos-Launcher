## What's new

SOAT miner GPU backend: Auto (same detect as before), CUDA, or Vulkan. Use Vulkan on machines that cannot run CUDA (AMD cards, missing NVIDIA). Auto stays the default, so existing NVIDIA rigs keep CUDA. The choice is saved in the SOAT service settings and takes effect by restarting the miner (not counted as a crash). Forcing CUDA with no NVIDIA GPU stays Waiting instead of crash-looping.

<!-- Keep each paragraph on one line: release notes show line breaks as written. -->

## Downloads

- **Windows 10/11:** `Lithos-Launcher-Setup-{{VERSION}}.exe`
- **Ubuntu, Debian and relatives:** `Lithos-Launcher-{{VERSION}}.deb`, installed with `sudo apt install ./Lithos-Launcher-{{VERSION}}.deb`. Use this rather than the AppImage: it runs with Chromium's sandbox on and needs no extra packages.
- **Other Linux (x64):** `Lithos-Launcher-{{VERSION}}.AppImage`. It needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04), and runs without Chromium's sandbox where the system blocks it.

## Unsigned builds

The builds aren't code-signed yet. On Windows, SmartScreen may show "Windows protected your PC": choose **More info → Run anyway**. Mark the AppImage executable before running it (`chmod +x`).

## Verify your download

- Linux: `sha256sum -c SHA256SUMS --ignore-missing`
- Windows (PowerShell): `Get-FileHash .\Lithos-Launcher-Setup-{{VERSION}}.exe`, and compare it with the line in SHA256SUMS

## Upgrading

Install over the previous version. The node, client, chain data and wallet live in `~/Lithos` (`C:\Users\<you>\Lithos` on Windows) and are kept. Uninstalling never removes them.

## Before mining for real

- Use a wallet made for mining, not your savings wallet, and keep its seed phrase on paper.
- Try **Test mining** first: it sends no transactions. A commitment locks your difficulty for 845 blocks.

## Requirements

64-bit Windows 10/11 or Linux, about 8 GB of RAM, tens of GB of disk for the chain, and a GPU miner that supports Autolykos 2.

## Problems?

Open an issue at https://github.com/Lithos-Protocol/Lithos-Launcher/issues with the relevant lines from the Node or Client log tab.
