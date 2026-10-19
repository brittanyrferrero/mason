import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'

// Text copied out of a Mason window goes through this on its way to the clipboard (tmux's copy-command).
// Claude wraps its replies with hard line breaks at the window's width, so pasted elsewhere they arrive chopped up.
// This joins them back into whole paragraphs. Blank lines between paragraphs and list items each keep their own
// line; Claude's ⏺ marker and its indent are dropped. A one-line copy passes through untouched.
// For an exact copy, ⌥-drag and ⌘C still copy precisely what's on screen.
export const COPY_SCRIPT = join(DATA_DIR, 'copy-unwrap.pl')

const SCRIPT = String.raw`#!/usr/bin/perl
# Written by Mason. Joins Claude's wrapped lines back into paragraphs before text reaches the clipboard.
use strict; use warnings;
binmode STDIN, ':encoding(UTF-8)'; binmode STDOUT, ':encoding(UTF-8)';
local $/; my $t = <STDIN>; $t = '' unless defined $t;
if ($t !~ /\n\s*\S/) { print $t; exit 0 }
my @l = split /\n/, $t, -1;
s/\s+$// for @l;
s/^(\s*)\x{23FA}\s?/$1  / for @l;   # Claude's reply marker
s/^(\s*)\x{25CF}\s?/$1  / for @l;   # (and its other form)
my $min;
for (@l) { next unless /\S/; my ($i) = /^( *)/; $min = length $i if !defined $min || length($i) < $min; }
$min = 0 unless defined $min;
s/^ {$min}// for @l;
my $item = qr/^\s*(?:[-*\x{2022}\x{25AA}\x{25E6}]|\d+[.)])\s/;   # list items
my $block = qr/^\s*(?:#|\||\x{23BF}|\x{2514}|\x{251C}|\x{2502}|>\s)/;  # headings, tables, tool output, quotes
my @out; my $prev = ''; my $base = 0;   # $prev: '' (start or blank), 'text', 'item', 'keep' (shown as is)
for my $line (@l) {
  if ($line !~ /\S/) { push @out, '' if @out && $out[-1] ne ''; $prev = ''; next; }
  my ($ind) = $line =~ /^( *)/; my $n = length $ind;
  (my $bare = $line) =~ s/^\s+//;
  # Tool output, code, tables: once started, indented lines stay exactly as shown until the next blank line.
  if ($prev eq 'keep' && $n > 0) { push @out, $line; next; }
  if ($line =~ $block) { push @out, $line; $prev = 'keep'; next; }
  if ($line =~ $item) {
    $base = $n if $prev ne 'item';
    push @out, (' ' x ($n > $base ? $n - $base : 0)) . $bare; $prev = 'item'; next;
  }
  if ($prev eq 'item' && $n > $base) { $out[-1] .= ' ' . $bare; next; }   # an item's wrapped lines
  if ($prev eq 'text') { $out[-1] .= ' ' . $bare; next; }                 # a paragraph's wrapped lines
  if ($n >= 4 && $prev eq '') { push @out, $line; $prev = 'keep'; next; }  # an indented block: code
  push @out, $bare; $prev = 'text';
}
pop @out while @out && $out[-1] eq '';
print join("\n", map { $_ eq '' ? '' : $_ } @out);
`

// What tmux runs on every copy. If unwrapping fails for any reason, the text is copied exactly as it was.
export const COPY_COMMAND = join(DATA_DIR, 'copy.sh')
const COMMAND = `#!/bin/sh
# Written by Mason. tmux's copy-command: unwrap Claude's lines (copy-unwrap.pl), then put the text on the clipboard.
t=$(cat; printf x); t=\${t%x}
out=$(printf '%s' "$t" | /usr/bin/perl "$HOME/.mason/copy-unwrap.pl" 2>/dev/null; printf x); out=\${out%x}
[ -n "$out" ] || out=$t
printf '%s' "$out" | pbcopy
`

export function writeCopyScript(): void {
  writeFileSync(COPY_SCRIPT, SCRIPT, { mode: 0o700 })
  writeFileSync(COPY_COMMAND, COMMAND, { mode: 0o700 })
}
