# LuCI support for SWUpdate

## Description

This is an LuCI web UI application for software updates using [SWUpdate](https://github.com/sbabic/swupdate).

*It's under development...*

## Localization

The application has translation for the following languages:
- English (original)
- Russian

## Dependencies and Limitations

This application will not work properly with the original LuCI and OpenWrt. This application is designed to work in the [TanoWrt](https://github.com/tano-systems/meta-tanowrt) distribution and depends on a lot of changes in the packages of this distribution compared to the original in OpenWrt.

## Licenses

This application is free software; you can redistribute it and/or modify it under the terms of the [MIT](https://opensource.org/licenses/MIT) license. See [LICENSE](LICENSE) for details.

We used Alert Icon by Eva Icons [1] (file `htdocs/luci-static/resources/swupdate/icon-failed.svg`) to indicate the failure of the firmware upgrading. Only the color of the icon has been changed compared to the original. This icon are licensed under the [Creative Commons 4 Attribution](https://creativecommons.org/licenses/by/4.0/) license.

[1]: https://iconscout.com/icon/alert-1767533

## Maintainers

Anton Kikin <a.kikin@tano-systems.com>
