{ pkgs }: {
    deps = [
      pkgs.xorg.libXrandr
      pkgs.xorg.libXfixes
      pkgs.xorg.libXcomposite
      pkgs.xorg.libXrender
      pkgs.xorg.libXdamage
      pkgs.xorg.libxshmfence
      pkgs.xorg.libxcb
      pkgs.freetype
      pkgs.fontconfig
      pkgs.alsa-lib
      pkgs.expat
      pkgs.cairo
      pkgs.pango
      pkgs.mesa
      pkgs.libxkbcommon
      pkgs.libdrm
      pkgs.cups
      pkgs.at-spi2-core
      pkgs.at-spi2-atk
      pkgs.atk
      pkgs.dbus
      pkgs.nspr
      pkgs.nss
    ];
  }
  