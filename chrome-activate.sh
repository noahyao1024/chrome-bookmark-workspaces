#!/bin/zsh -f
# One compiled process handles timing, native activation, and definite-miss fallback.
exec ./chrome-launcher --activate "$1"
