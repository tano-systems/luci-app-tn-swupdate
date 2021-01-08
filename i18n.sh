#!/bin/sh
# SPDX-License-Identifier: MIT

mkdir -p po/templates

i18n-scan.pl . > po/templates/swupdate.pot
i18n-update.pl po
