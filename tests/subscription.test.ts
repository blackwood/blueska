// Tests for isSkaRelated() gate logic in src/subscription.ts
//
// Add cases here whenever you find a new false positive or false negative.
// Run with: yarn test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isSkaRelated, isMentionSpam } from '../src/subscription'

function pass(text: string) {
  assert.equal(isSkaRelated(text), true, `Expected PASS: "${text}"`)
}

function fail(text: string) {
  assert.equal(isSkaRelated(text), false, `Expected FAIL: "${text}"`)
}

function spam(text: string) {
  assert.equal(isMentionSpam(text), true, `Expected SPAM: "${text}"`)
}

function notSpam(text: string) {
  assert.equal(isMentionSpam(text), false, `Expected NOT SPAM: "${text}"`)
}

// ---------------------------------------------------------------------------
// Mention spam filter
// ---------------------------------------------------------------------------

describe('mention spam filter', () => {
  test('mention flood (MutualMusic-style) → spam', () =>
    spam(
      '#MutualMusic 🇯🇲 Ska, Reggae, etc inspired songs\n' +
      '@user1.bsky.social\n@user2.bsky.social\n@user3.bsky.social\n' +
      '@user4.bsky.social\n@user5.bsky.social\n@user6.bsky.social\n' +
      '@user7.bsky.social\n@user8.bsky.social\n@user9.bsky.social',
    ))
  test('below floor (2 mentions) → not spam', () =>
    notSpam('Great ska show tonight! Thanks @friend1.bsky.social and @friend2.bsky.social'))
  test('3 mentions but plenty of prose → not spam', () =>
    notSpam('Saw Less Than Jake with @friend1 @friend2 @friend3 — best ska show in years, skanking all night'))
  test('hashtag-only (no mentions) → not spam', () =>
    notSpam('#ska #skaPunk #reggae great vibes tonight at the show'))
})

// ---------------------------------------------------------------------------
// High-confidence patterns — should always pass without music context
// ---------------------------------------------------------------------------

describe('high confidence: compound terms', () => {
  test('ska-punk', () => pass('Just released a new ska-punk EP'))
  test('ska-core', () => pass('Hardcore meets skacore at its finest'))
  test('skanking', () => pass('Everyone was skanking at the front of the pit'))
  test('#ska hashtag', () => pass('Loving this album #ska'))
  test('#blueska hashtag', () => pass('New release from the Toasters #blueska'))
  test('#blueska alone', () => pass('just discovered this band #blueska'))
  test('third wave ska', () => pass('Classic third wave ska energy'))
  test('2-tone ska', () => pass('2-tone ska was revolutionary'))
  test('rudeboy', () => pass('Proud rudeboy since 1999'))
  test('rudegirl', () => pass('Rudegirl forever'))
})

describe('high confidence: unambiguous artists', () => {
  test('Skatalites', () => pass('The Skatalites are the originators'))
  test('Operation Ivy', () => pass('Operation Ivy defined an era'))
  test('Less Than Jake', () => pass('Less Than Jake new album!'))
  test('Streetlight Manifesto', () => pass('Streetlight Manifesto tour dates announced'))
  test('Reel Big Fish', () => pass('Reel Big Fish are always fun live'))
  test('Mighty Mighty Bosstones', () => pass('Mighty Mighty Bosstones reunion show'))
  test('Toots and the Maytals', () => pass('Toots and the Maytals - reggae legends'))
  test('Desmond Dekker', () => pass('Desmond Dekker - Israelites is a classic'))
})

// ---------------------------------------------------------------------------
// Madness: structural classification (ported from madness_filter.py)
// ---------------------------------------------------------------------------

describe('Madness: clearly the band (should PASS)', () => {
  test('mid-sentence standalone - show context', () =>
    pass('Madness played a great show last night'))
  test('mid-sentence standalone - live context', () =>
    pass('I saw Madness live in 1984'))
  test('mid-sentence standalone - band context', () =>
    pass('I really love the band Madness'))
  test('coordinator stops right-flank scan', () =>
    pass('I love Madness and Blur'))
  test('comma stops right-flank scan, with context', () =>
    pass('I love Madness, Blur and Oasis — ska rules'))
  test('sentence-initial + music context', () =>
    pass('Madness played a great show last night'))
  // Known limitation: "Saw" is capitalized (sentence-initial in English) and
  // directly precedes "Madness", so flankCount counts it as a flanking proper
  // noun → score 0.22 → REJECT. Common workaround: "just saw Madness live".
  test('sentence-initial word before Madness → REJECT (known limitation)', () =>
    fail('Saw Madness live last night!'))
})

describe('Madness: compound proper nouns (should FAIL)', () => {
  test('March Madness — direct adjacency (was regex gap before)', () =>
    fail('March Madness is on!'))
  test('March Madness with music context (was false positive before)', () =>
    fail('March Madness watch party with the band!'))
  test('Sound of Madness (Shinedown album)', () =>
    fail('Sound of Madness is a great album by Shinedown'))
  test('Midnight Madness with music context (was regex gap before)', () =>
    fail('Midnight Madness was a great show last night'))
  test('A Little Bit of Madness', () =>
    fail('A Little Bit of Madness'))
  test('The Madness of Markets (title in quotes)', () =>
    fail('"The Madness of Markets" is my book pick this week'))
  test('Shakespeare Festival Madness', () =>
    fail('Shakespeare Festival Madness — come join us!'))
  test('lowercase madness — common noun', () =>
    fail('the madness of it all'))
})

// ---------------------------------------------------------------------------
// Nordic ska exclusion
// ---------------------------------------------------------------------------

describe('Nordic ska: Swedish/Norwegian auxiliary verb (should FAIL)', () => {
  test('jag ska', () => fail('Jag ska göra det imorgon'))
  test('ska vara', () => fail('Det ska vara kul'))
  test('ska vi', () => fail('Ska vi gå på konsert?'))
  test('inverted du ska', () => fail('ska du komma?'))
  test('ska fram (directional particle)', () =>
    fail('Om sanningen ska fram (vill du ligga med mig då) och måste googla'))
  test('ska hem', () => fail('Jag ska hem nu'))
  test('ska dit', () => fail('Vi ska dit imorgon'))
})

describe('Nordic ska: rescued by English music signals', () => {
  test('Swedish + ska band context', () =>
    pass('Jag ska gå på ska gig ikväll!'))
})

// ---------------------------------------------------------------------------
// Ambiguous band names + music context
// ---------------------------------------------------------------------------

describe('ambiguous bands: require music context', () => {
  test('The Specials + gig', () => pass('The Specials gig was amazing'))
  test('Goldfinger + band', () => pass('Goldfinger is a great ska-punk band'))
  test('Bad Manners + concert', () => pass('Bad Manners concert tonight!'))
  test('rocksteady (closed) + vinyl', () => pass('Found some great rocksteady vinyl'))
  test('rock-steady (hyphen) + vinyl', () => pass('Found some great rock-steady vinyl'))
  test('rock steady (space) — blocked: too broad', () => fail('Rock Steady is a great song'))
  test('Save Ferris + album', () => pass('Save Ferris album out now'))
})

describe('ambiguous bands: blocked without music context', () => {
  test('goldfinger without context', () => fail('goldfinger is a great film'))
  test('Bad Manners — lowercase always fails', () => fail('That was bad manners at dinner'))
  test('rocksteady without context', () => fail('Rocky used a rocksteady stance'))
})

describe('Goldfinger/Bond: Bond film exclusion', () => {
  test('James Bond film context → blocked', () =>
    fail('Although the most commonly cited favorite James Bond film is Goldfinger'))
  test('007 + Goldfinger → blocked', () =>
    fail('Goldfinger is my favorite 007 film, Sean Connery was perfect'))
  test('bond film alone → blocked', () =>
    fail('The bond film Goldfinger holds up well'))
  test('bond movie alone (no Goldfinger) → blocked', () =>
    fail('watched a great bond movie last night'))
  test('james bond alone (no Goldfinger) → blocked', () =>
    fail('James Bond is the best spy franchise'))
  test('music context rescues: band + 007 + Goldfinger', () =>
    // "band" hits MUSIC_CONTEXT → hasMusicCtx → rescue
    pass('my ska band covers the 007 Goldfinger theme'))
  test('high-confidence ska rescues: ska-punk + Bond villain', () =>
    pass('Goldfinger is a great ska-punk band, not just a Bond villain'))
})

// ---------------------------------------------------------------------------
// Exclusion patterns
// ---------------------------------------------------------------------------

describe('hard exclusions', () => {
  test('crypto: $ska', () => fail('Buy $ska now before it moons!'))
  test('crypto: ska coin', () => fail('ska coin is the next big thing'))
  test('geography: Alaska', () => fail('Visiting Alaska next month'))
  test('geography: Nebraska', () => fail('Nebraska is a big state'))
  test('TMNT: Bebop and Rocksteady (closed)', () =>
    fail('Bebop and Rocksteady are the best TMNT villains'))
  test('TMNT: reversed (closed)', () =>
    fail('Rocksteady and Bebop cause chaos'))
  test('TMNT: rock steady (space) and bebop', () =>
    fail('Joe Rogan is like if rock steady and bebop had a relationship'))
  test('TMNT: bebop and rock steady (space)', () =>
    fail('bebop and rock steady are iconic TMNT villains'))
  test('Arkham games', () => fail('Batman Arkham city is amazing'))
  test('Rocksteady Studios', () => fail('Rocksteady Studios made great games'))
  test('skanks + skanking (derogatory co-occurrence)', () =>
    fail('Stop calling women skanks, skanking is a dance'))
  test('skanking alone (ska dancing) → PASS', () =>
    pass('Everyone was skanking at the front of the pit!'))
  test('polska', () => fail('Playing polska on the fiddle tonight'))
  test('Slavic feminine surname (Jasińska)', () =>
    fail('An admirable strength. The Nazis wanted to break Alina Jasińska'))
  test('Slavic surname does not block HIGH_CONFIDENCE in same post', () =>
    pass('Alina Jasińska loves #ska'))
})

// ---------------------------------------------------------------------------
// Reply gate: replies only pass HIGH_CONFIDENCE (tested via note — the
// reply gate is enforced in processEvent, not isSkaRelated itself,
// so these test the underlying gate function used for root posts)
// ---------------------------------------------------------------------------

describe('standalone ska: requires context', () => {
  test('ska + band', () => pass('Listening to some great ska bands'))
  test('ska + gig', () => pass('ska gig tonight!'))
  test('ska alone — no context', () => fail('We ska go to the store'))
  test('two-tone + music context', () => pass('Classic two-tone record in my collection'))
  test('rude boy + show', () => pass('every rude boy at the show'))
})
