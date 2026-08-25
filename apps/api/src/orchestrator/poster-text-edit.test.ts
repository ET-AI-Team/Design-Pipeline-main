import { describe, it, expect } from 'bun:test';
import { pickEditSize, buildFullContextEditPrompt, buildVerificationRubric, selectElementsToCrop, MAX_REFERENCE_CROPS, type FullContextEditParams } from './poster-text-edit';
import type { AdCopy, PosterStyleSpec, VisualReferenceHint } from '../providers/openai.client';

const NO_VISUAL_REF: VisualReferenceHint = { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } };

describe('pickEditSize', () => {
  it('picks the landscape enum for a wide canvas', () => {
    expect(pickEditSize(1536, 1024)).toBe('1536x1024');
  });
  it('picks the portrait enum for a tall canvas', () => {
    expect(pickEditSize(1024, 1536)).toBe('1024x1536');
  });
  it('picks square for a roughly 1:1 canvas', () => {
    expect(pickEditSize(1024, 1024)).toBe('1024x1024');
  });
});

const COPY: AdCopy = {
  headlineLines: ['Feel Good All Day', 'Every Single Time'],
  subtext: 'A simple daily stretching routine',
  ctaLabel: 'JOIN TODAY',
  priceText: 'From ₹299/month',
  trustItems: ['Flexible timing', 'Expert guidance'],
  otherElementTexts: [],
};

const STYLE: PosterStyleSpec = {
  marginXRatio: 0.04,
  spacing: { logoToHeadlineGapRatio: 0.03, headlineToSubtextGapRatio: 0.015, afterTextBlockGapRatio: 0.02, ctaToTrustListGapRatio: 0.015 },
  headline: {
    lineCount: 2,
    align: 'left',
    lines: [
      { fontSizeRatio: 0.05, fontWeight: 500, styleDescription: 'a light, casual script-like lead-in', color: { type: 'solid', color: '#2b2b2b' } },
      { fontSizeRatio: 0.08, fontWeight: 800, styleDescription: 'a bold condensed italic display font', color: { type: 'gradient', color: '#d4af37', gradientTo: '#ffffff', gradientDirection: 'diagonal' } },
    ],
    visualReference: NO_VISUAL_REF,
  },
  subtext: { present: true, fontSizeRatio: 0.024, fontWeight: 500, styleDescription: 'italic, medium-weight sans-serif', color: { type: 'solid', color: '#2b2b2b' }, align: 'left', visualReference: NO_VISUAL_REF },
  cta: {
    present: true,
    heightRatio: 0.1,
    cornerRadiusRatio: 0.02,
    fillColor: '#1a2a5e',
    labelTextColor: '#ffffff',
    labelFontWeight: 700,
    labelStyleDescription: 'bold uppercase sans-serif',
    hasPriceBand: true,
    priceBandColor: '#ffffff',
    priceTextColor: '#1a2a5e',
    priceFontWeight: 600,
    fontSizeRatio: 0.024,
    textAlign: 'center',
    textInsetRatio: 0.02,
    visualReference: NO_VISUAL_REF,
  },
  trustList: {
    present: true,
    itemCount: 2,
    layoutDescription: 'a full-width bar pinned to the bottom edge, each item with a filled circle checkmark',
    iconStyle: 'checkmark-filled',
    presentation: 'bar',
    heightRatio: 0.06,
    cardWidthRatio: 0.4,
    cardCornerRadiusRatio: 0,
    backgroundColor: '#1a2a5e',
    dividerColor: '#1a2a5e',
    textColor: '#ffffff',
    fontWeight: 600,
    fontSizeRatio: 0.018,
    checkmarkBadgeColor: '#ffffff',
    checkmarkIconColor: '#1a2a5e',
    checkmarkSizeRatio: 0.016,
    iconTextGapRatio: 0.01,
    iconOffsetRatio: 0.02,
    rowHeightRatio: 0.05,
    priceRowHeightRatio: 0.04,
    cardPaddingXRatio: 0.02,
    priceRow: { present: false, backgroundColor: '#ffffff', textColor: '#1a2a5e', fontWeight: 600 },
    promoBadge: { present: false, description: '' },
    visualReference: NO_VISUAL_REF,
  },
  textColumnWidthRatio: 0.35,
  centerXRatio: 0.215, // matches marginXRatio(0.04) + textColumnWidthRatio(0.35)/2, for tests that predate the direct-read field
  otherElements: [],
  elementOrder: ['headline', 'subtext', 'cta', 'trustList'],
};

const BASE_PARAMS: FullContextEditParams = {
  campaignBrief: 'a mock campaign brief',
  compositionGuide: 'subject fills the right two-thirds, clean space on the left',
  backgroundTreatment: '',
  photoStyle: { colorGrading: 'warm tones', lighting: 'soft daylight', setting: 'outdoor path', framing: 'medium shot' },
  logoBox: { x: 46, y: 46, width: 225, height: 100 },
  copy: COPY,
  style: STYLE,
  canvasW: 1024,
  canvasH: 1024,
  referenceCrops: [],
  includeFullReferenceImage: false,
};

describe('buildFullContextEditPrompt', () => {
  it('quotes every copy field verbatim, labels headline lines separately', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('Line 1: "Feel Good All Day"');
    expect(prompt).toContain('Line 2: "Every Single Time"');
    expect(prompt).toContain('"A simple daily stretching routine"');
    expect(prompt).toContain('"JOIN TODAY"');
    expect(prompt).toContain('"From ₹299/month"');
    expect(prompt).toContain('"Flexible timing"');
    expect(prompt).toContain('"Expert guidance"');
  });

  it('real bug found live: gives each headline line its own distinct style instruction, not one shared style', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('a light, casual script-like lead-in');
    expect(prompt).toContain('a bold condensed italic display font');
    // The two lines' instructions must be genuinely different blocks, not the same text repeated.
    const leadInIdx = prompt.indexOf('a light, casual script-like lead-in');
    const punchlineIdx = prompt.indexOf('a bold condensed italic display font');
    expect(leadInIdx).toBeGreaterThanOrEqual(0);
    expect(punchlineIdx).toBeGreaterThan(leadInIdx);
  });

  it('round 4 fix: isolates typography into its own sentence per element, separate from numeric size/weight/color', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('Line 1 typography: a light, casual script-like lead-in. This is the single most important part');
    expect(prompt).toContain('Line 1 size/color: font size');
    expect(prompt).toContain('Subtext typography: italic, medium-weight sans-serif.');
    expect(prompt).toContain('Subtext size/color: font size');
    expect(prompt).toContain('CTA button label typography: bold uppercase sans-serif.');
  });

  it('real bug found live: wires cta.textAlign into the prompt - it was extracted but never once read, so the CTA label always rendered left-aligned regardless of the reference', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // STYLE.cta.textAlign = 'center'
    expect(prompt).toContain('label text center-aligned within the button');

    const leftAligned: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, textAlign: 'left' } };
    const leftPrompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: leftAligned });
    expect(leftPrompt).toContain('label text left-aligned within the button');
  });

  it('real bug found live: resolves a gradient ColorSpec into an explicit gradient instruction, not a flat color', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('gradient fill from #d4af37 to #ffffff');
    expect(prompt).toContain('diagonal');
  });

  it('resolves a solid ColorSpec into a flat color instruction', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('solid color #2b2b2b');
  });

  it('strengthens color instructions with explicit "match exactly, do not substitute" language for both solid and gradient fills', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('solid color #2b2b2b - match this color exactly, do not substitute a similar-looking shade');
    expect(prompt).toContain('a diagonal gradient fill from #d4af37 to #ffffff - match both colors exactly, do not substitute a similar-looking shade or flatten it to one solid color');
  });

  it('states each element\'s font size as both a percentage and a concrete pixel value against the real canvas width', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // canvasW: 1024
    // headline line 2: fontSizeRatio 0.08 -> 82px
    expect(prompt).toContain('8% of canvas width (~82px)');
  });

  it('real fix: states a deterministically-computed relative-size sentence anchoring the headline against subtext/CTA/info-block text, never a second AI judgment', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    // headline max ratio 0.08 vs subtext 0.024 -> 3.3x, vs cta 0.024 -> 3.3x, vs trustList 0.018 -> 4.4x
    expect(prompt).toContain('This headline should read as roughly 3.3x the size of the subtext and roughly 3.3x the size of the CTA label and roughly 4.4x the size of the bottom info block\'s text');
    expect(prompt).toContain('size these relative to each other precisely, not each in isolation');
  });

  it('states the photo and logo as already-correct and must-not-change, with the real logo coordinates', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('must NOT change in any way');
    expect(prompt).toContain('subject fills the right two-thirds, clean space on the left');
    expect(prompt).toContain('(46, 46)');
    expect(prompt).toContain('225x100');
    expect(prompt).toContain('Do not cover, move, resize, recolor, or otherwise alter it');
  });

  it('omits the background-treatment line when there is none, includes it when present', () => {
    const withoutTreatment = buildFullContextEditPrompt(BASE_PARAMS);
    expect(withoutTreatment).not.toContain('already baked into the photo');

    const withTreatment = buildFullContextEditPrompt({ ...BASE_PARAMS, backgroundTreatment: 'a soft gradient panel' });
    expect(withTreatment).toContain('a soft gradient panel');
  });

  it('quotes the bottom info block\'s layoutDescription near-verbatim as the authoritative structure', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('a full-width bar pinned to the bottom edge, each item with a filled circle checkmark');
  });

  it('real bug found live: a reference with no CTA at all gets an explicit "do not add" instruction, not silence', () => {
    const noCta: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, present: false } };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: noCta });
    expect(prompt).toContain('Do NOT add a standalone CTA button or pill of any kind');
  });

  it('a reference with a CTA present gets no "do not add a CTA" instruction', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // STYLE.cta.present = true
    expect(prompt).not.toContain('Do NOT add a standalone CTA button');
  });

  it('a plain bulleted list (no icon) gets an explicit "do not add checkmarks" instruction', () => {
    const bulletStyle: PosterStyleSpec = {
      ...STYLE,
      trustList: { ...STYLE.trustList, iconStyle: 'none', layoutDescription: 'a plain vertical list of italic bulleted phrases, no box, no icon' },
    };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: bulletStyle });
    expect(prompt).toContain('Do NOT add checkmark icons, bullet dots, or any icon');
    expect(prompt).toContain('a plain vertical list of italic bulleted phrases, no box, no icon');
  });

  it('an absent promo badge gets an explicit "do not add" instruction; a present one is described and its text quoted', () => {
    const withoutBadge = buildFullContextEditPrompt(BASE_PARAMS); // promoBadge.present = false
    expect(withoutBadge).toContain('Do NOT add a separate promo/offer badge');

    const withBadge: PosterStyleSpec = { ...STYLE, trustList: { ...STYLE.trustList, promoBadge: { present: true, description: 'a navy pill with a white percent icon' } } };
    const copyWithBadge: AdCopy = { ...COPY, promoBadgeText: 'EARLY BIRD SALE' };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: withBadge, copy: copyWithBadge });
    expect(prompt).not.toContain('Do NOT add a separate promo/offer badge');
    expect(prompt).toContain('a navy pill with a white percent icon');
    expect(prompt).toContain('"EARLY BIRD SALE"');
  });

  it('a reference with no bottom info block at all gets an explicit "do not add" instruction', () => {
    const noTrustList: PosterStyleSpec = { ...STYLE, trustList: { ...STYLE.trustList, present: false } };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: noTrustList });
    expect(prompt).toContain('Do NOT add a bottom trust/info list or bar of any kind');
  });

  it('states no-mask constraints explicitly - never repaint the photo/logo, never add unrequested elements', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('Do NOT alter the photograph or the logo in any way');
    expect(prompt).toContain('Do NOT add any decorative element');
    expect(prompt).toContain('Do NOT use a hyphen or dash');
  });

  it('real bug found live: forbids adding a new physical prop (e.g. a fabricated race bib) even if the brief or reference mentions/shows one', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('do NOT add any new physical object, prop, or accessory onto the subject or scene');
    expect(prompt).toContain('e.g. a race bib, a sign, a piece of clothing or jewelry');
  });

  it('round 8 fix: text renders flat by default - no unconditional shadow instruction anymore', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain('Do NOT add any shadow, glow, or outline treatment to any text UNLESS that specific element\'s own typographic description above explicitly mentions one');
    expect(prompt).not.toContain('should have natural shadow/contrast treatment');
  });

  it('round 8 fix: omits the CTA price-band render instruction when hasPriceBand is true but no genuine priceText was generated', () => {
    const noRealPrice: AdCopy = { ...COPY, priceText: undefined };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, copy: noRealPrice }); // STYLE.cta.hasPriceBand = true
    expect(prompt).not.toContain('with a second band below the label inside the SAME button');
    expect(prompt).toContain("Do NOT add a second price/offer band inside or below the CTA button - no real price or offer information was available for this campaign.");

    const withRealPrice = buildFullContextEditPrompt(BASE_PARAMS); // COPY.priceText is set
    expect(withRealPrice).toContain('with a second band below the label inside the SAME button');
  });

  it('appends prior-attempt feedback when provided, omits the section when absent', () => {
    const withFeedback = buildFullContextEditPrompt({ ...BASE_PARAMS, feedback: 'the CTA text overflowed its area' });
    expect(withFeedback).toContain('Previous attempt feedback - fix this specifically: the CTA text overflowed its area');

    const withoutFeedback = buildFullContextEditPrompt(BASE_PARAMS);
    expect(withoutFeedback).not.toContain('Previous attempt feedback');
  });

  // otherElements[i].parts[] - a real defect (a co-branding badge with a
  // plain label, an icon-box, and a serif wordmark all collapsed into one
  // flattened, wrongly-ordered, single-font blob) confirmed the old
  // one-description-one-text shape couldn't express multi-part elements
  // with a real position/size anchor - see PosterStyleSpec.otherElements'
  // own doc comment.
  const badgeElement = {
    description: 'a pill-shaped badge outline below the logo',
    positionDescription: 'directly below the logo, left-aligned to the text column',
    align: 'left' as const,
    approxYRatio: 0.12,
    approxHeightRatio: 0.04,
    gapAboveRatio: 0.02,
    parts: [
      { text: 'PRESENTED BY', hasText: true, styleDescription: 'plain white sans-serif', color: { type: 'solid' as const, color: '#ffffff' } },
      { text: 'ET', hasText: false, styleDescription: 'a small red icon-box glyph', color: { type: 'solid' as const, color: '#e4002b' } },
      { text: 'The Economic Times', hasText: true, styleDescription: 'a serif wordmark', color: { type: 'solid' as const, color: '#ffffff' } },
    ],
    visualReference: NO_VISUAL_REF,
  };

  it('renders each otherElements entry with a real position/size/gap anchor, and each part in reading order with its own style/color', () => {
    const styleWithOther: PosterStyleSpec = { ...STYLE, otherElements: [badgeElement], elementOrder: [...STYLE.elementOrder, 'otherElements[0]'] };
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['In Partnership With', 'a short generic wordmark'] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: styleWithOther, copy: copyWithOther });
    expect(prompt).toContain('a pill-shaped badge outline below the logo');
    expect(prompt).toContain('Position: directly below the logo, left-aligned to the text column');
    expect(prompt).toContain('Vertical center ~12% of canvas height');
    // Part 1 (has text) gets its generated text quoted verbatim.
    expect(prompt).toContain('Part 1 of 3, in this left-to-right order: solid color #ffffff');
    expect(prompt).toContain('Render this exact text on it, verbatim: "In Partnership With"');
    // Part 2 (icon-only) gets no quoted text.
    expect(prompt).toContain('Part 2 of 3, in this left-to-right order: solid color #e4002b');
    expect(prompt).toContain('This part is icon/glyph only, no text.');
    // Part 3 (has text) gets the SECOND generated text, not the first.
    expect(prompt).toContain('Part 3 of 3, in this left-to-right order: solid color #ffffff');
    expect(prompt).toContain('Render this exact text on it, verbatim: "a short generic wordmark"');
    // Parts must appear in their real order - part 1's text before part 3's.
    expect(prompt.indexOf('In Partnership With')).toBeLessThan(prompt.indexOf('a short generic wordmark'));
  });

  it('round 4 fix: flattens otherElementTexts per-part across ALL elements in element-then-part order, not per-element', () => {
    const ribbon = {
      description: 'a thin decorative corner ribbon, top right',
      positionDescription: 'top right corner',
      align: 'left' as const,
      approxYRatio: 0.05,
      approxHeightRatio: 0.03,
      gapAboveRatio: 0.01,
      parts: [{ text: null, hasText: false, styleDescription: 'a plain diagonal ribbon shape', color: { type: 'solid' as const, color: '#ffffff' } }],
      visualReference: NO_VISUAL_REF,
    };
    const styleWithOther: PosterStyleSpec = {
      ...STYLE,
      otherElements: [ribbon, badgeElement],
      elementOrder: [...STYLE.elementOrder, 'otherElements[0]', 'otherElements[1]'],
    };
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['In Partnership With', 'a short generic wordmark'] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: styleWithOther, copy: copyWithOther });
    // The ribbon (element 0, no text parts) must not consume any of the two generated texts.
    expect(prompt).toContain('Render this exact text on it, verbatim: "In Partnership With"');
    expect(prompt).toContain('Render this exact text on it, verbatim: "a short generic wordmark"');
  });

  it('an empty otherElements array renders no "Additional element" lines', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // STYLE.otherElements = []
    expect(prompt).not.toContain('Additional element');
  });

  it('real bug found live: a sibling part with genuinely no text gets an explicit "omit this part" instruction, not silence', () => {
    // Previously: hasText true + empty string fell through to the SAME
    // empty-string branch as "no instruction needed" - the model then
    // invented its own content (e.g. reading a city name off the photo)
    // because nothing told it to omit the part.
    const styleWithOther: PosterStyleSpec = { ...STYLE, otherElements: [badgeElement], elementOrder: [...STYLE.elementOrder, 'otherElements[0]'] };
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['In Partnership With', ''] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: styleWithOther, copy: copyWithOther });
    expect(prompt).toContain('Render this exact text on it, verbatim: "In Partnership With"');
    expect(prompt).toContain('No genuine text was available for this part - do NOT render it at all');
    expect(prompt).not.toContain('Render this exact text on it, verbatim: ""');
  });

  it('real bug found live: an element with ZERO genuine text across all its parts is omitted entirely, not rendered as a bare icon shell', () => {
    const styleWithOther: PosterStyleSpec = { ...STYLE, otherElements: [badgeElement], elementOrder: [...STYLE.elementOrder, 'otherElements[0]'] };
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['', ''] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: styleWithOther, copy: copyWithOther });
    expect(prompt).toContain('OMIT THIS ENTIRE ELEMENT - no genuine content was available for this campaign');
    // None of the per-part rendering lines should appear once the whole element is omitted.
    expect(prompt).not.toContain('Part 1 of 3');
    expect(prompt).not.toContain('This part is icon/glyph only, no text.');
  });

  it('emits blocks in elementOrder\'s actual sequence, not the fixed headline/subtext/cta/trustList order', () => {
    // Reference where the trust list sits ABOVE the CTA - a real
    // structural case this pipeline used to always get wrong by always
    // emitting cta before trustList regardless of the reference.
    const reordered: PosterStyleSpec = { ...STYLE, elementOrder: ['headline', 'trustList', 'subtext', 'cta'] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: reordered });
    const trustIdx = prompt.indexOf('Bottom info block');
    const subtextIdx = prompt.indexOf('Subtext typography');
    const ctaIdx = prompt.indexOf('CTA button label typography');
    expect(trustIdx).toBeGreaterThan(0);
    expect(subtextIdx).toBeGreaterThan(trustIdx);
    expect(ctaIdx).toBeGreaterThan(subtextIdx);
  });

  it('round 4 fix: a CTA price band is forbidden explicitly when hasPriceBand is false, allowed silently when true', () => {
    const noPriceBand: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, hasPriceBand: false } };
    const withoutBand = buildFullContextEditPrompt({ ...BASE_PARAMS, style: noPriceBand });
    expect(withoutBand).toContain("Do NOT add a second price/offer band inside or below the CTA button - this design's CTA has no price band.");

    const withBand = buildFullContextEditPrompt(BASE_PARAMS); // STYLE.cta.hasPriceBand = true
    expect(withBand).not.toContain('Do NOT add a second price/offer band');
  });

  it('round 4 fix: a highlighted price row inside the info block is forbidden explicitly when absent, allowed silently when present', () => {
    const withoutRow = buildFullContextEditPrompt(BASE_PARAMS); // STYLE.trustList.priceRow.present = false
    expect(withoutRow).toContain('Do NOT add a highlighted price/offer row inside the bottom info block - none exists in this design.');

    const withRow: PosterStyleSpec = { ...STYLE, trustList: { ...STYLE.trustList, priceRow: { ...STYLE.trustList.priceRow, present: true } } };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: withRow });
    expect(prompt).not.toContain('Do NOT add a highlighted price/offer row');
  });

  it('round 5 fix: with no reference crops attached, omits the crop-reference paragraph and the no-copy rule entirely', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // referenceCrops: []
    expect(prompt).not.toContain('Additional reference images are attached below');
    expect(prompt).not.toContain('Do NOT copy any literal text, numbers, or words visible in these reference crops');
  });

  it('round 5 fix: numbers attached reference crops starting at image 2 (image 1 is always the composite), labels each by its element', () => {
    const withCrops = buildFullContextEditPrompt({
      ...BASE_PARAMS,
      referenceCrops: [
        { name: 'headline', label: 'headline style reference', box: { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.2 } },
        { name: 'trustList', label: 'bottom info block style reference', box: { xRatio: 0, yRatio: 0.8, widthRatio: 1, heightRatio: 0.15 } },
      ],
    });
    expect(withCrops).toContain('Image 2: a real photo crop from a DIFFERENT, unrelated reference design, showing exactly how the reference\'s headline style reference should look');
    expect(withCrops).toContain('Image 3: a real photo crop from a DIFFERENT, unrelated reference design, showing exactly how the reference\'s bottom info block style reference should look');
    expect(withCrops).toContain('Do NOT copy any literal text, numbers, or words visible in these reference images');
  });

  it('real bug found live: Image 1 gets the same explicit, numbered role treatment as every reference image, with a standalone rule against blending similar-looking subject matter across images', () => {
    // Real defect: a job whose reference happened to depict similar
    // subject matter to the actual photo (both showed runners in front
    // of a city landmark) got real content blended from the reference
    // into Image 1's output (a runner's shirt pattern changed, the
    // landmark's rendering style drifted) - despite the reference-only
    // images each carrying their own "for style only" caveat. Image 1
    // itself was never given the same explicit, numbered role statement,
    // and there was no standalone rule addressing the actual failure
    // mode (two images coincidentally looking similar).
    const prompt = buildFullContextEditPrompt({
      ...BASE_PARAMS,
      referenceCrops: [{ name: 'headline', label: 'headline style reference', box: { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.2 } }],
    });
    expect(prompt).toContain('Images attached to this request, in order, and what each one is for:');
    expect(prompt).toContain('- Image 1: THE PHOTO YOU ARE EDITING.');
    // The manifest states Image 1's role before any reference image's.
    expect(prompt.indexOf('- Image 1:')).toBeLessThan(prompt.indexOf('- Image 2:'));
    // The "don't blend similar subject matter" rule is bookended - once
    // up front, once in the closing "Do NOT" list - same discipline as
    // every other hard-to-honor rule in this file.
    const frontMention = prompt.indexOf('if Image 1 and any reference image above happen to show similar subject matter');
    const bookendMention = prompt.indexOf("Do NOT let Image 1's own subject, clothing, pose, background, or landmark drift toward how a reference image");
    expect(frontMention).toBeGreaterThanOrEqual(0);
    expect(bookendMention).toBeGreaterThan(frontMention);
  });

  it('a job with no reference crops attached still numbers Image 1 explicitly, without an empty/broken manifest', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // referenceCrops: []
    expect(prompt).toContain('- Image 1: THE PHOTO YOU ARE EDITING.');
    expect(prompt).not.toContain('- Image 2:');
  });

  it('round 7 fix: numbers the full-reference image correctly after all element crops, framed for scale/position only', () => {
    const prompt = buildFullContextEditPrompt({
      ...BASE_PARAMS,
      referenceCrops: [
        { name: 'headline', label: 'headline style reference', box: { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.2 } },
        { name: 'trustList', label: 'bottom info block style reference', box: { xRatio: 0, yRatio: 0.8, widthRatio: 1, heightRatio: 0.15 } },
      ],
      includeFullReferenceImage: true,
    });
    // 2 crops -> images 2 and 3 -> full reference is image 4.
    expect(prompt).toContain('Image 4: the FULL layout of that same different, unrelated reference design, shown only so you can judge scale and position');
    // Real bug found live: the old per-image "Do NOT copy this image's
    // specific photo, people, or logo" caveat wasn't enough on its own -
    // a real job whose reference happened to show similar subject matter
    // to Image 1 got its actual photo content blended with the
    // reference's. Replaced by a standalone, bookended rule that fires
    // regardless of which images are attached.
    expect(prompt).toContain("if Image 1 and any reference image above happen to show similar subject matter");
    expect(prompt).toContain("Do NOT let Image 1's own subject, clothing, pose, background, or landmark drift toward how a reference image");
  });

  it('round 7 fix: omits the full-reference paragraph when includeFullReferenceImage is false, even with crops attached', () => {
    const prompt = buildFullContextEditPrompt({
      ...BASE_PARAMS,
      referenceCrops: [{ name: 'headline', label: 'headline style reference', box: { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.2 } }],
      includeFullReferenceImage: false,
    });
    expect(prompt).not.toContain('FULL layout');
  });

  it('round 7 fix: bookends otherElementTexts in the top-level render list, not just in-context within the otherElements block', () => {
    const styleWithOther: PosterStyleSpec = {
      ...STYLE,
      otherElements: [
        {
          description: 'a badge', positionDescription: 'below the logo', align: 'left' as const, approxYRatio: 0.1, approxHeightRatio: 0.05, gapAboveRatio: 0.01,
          parts: [{ text: null, hasText: true, styleDescription: 'plain', color: { type: 'solid', color: '#fff' } }],
          visualReference: { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } },
        },
      ],
      elementOrder: [...STYLE.elementOrder, 'otherElements[0]'],
    };
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['Presented By Insider Daily'] };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: styleWithOther, copy: copyWithOther });
    expect(prompt).toContain('- Additional element labels: "Presented By Insider Daily"');
  });

  it('omits the additional-element-labels line when there are none', () => {
    const prompt = buildFullContextEditPrompt(BASE_PARAMS); // COPY.otherElementTexts = []
    expect(prompt).not.toContain('Additional element labels');
  });

  it('round 6 fix: frames each attached crop as a template to fill in, not inspiration', () => {
    const prompt = buildFullContextEditPrompt({
      ...BASE_PARAMS,
      referenceCrops: [{ name: 'headline', label: 'headline style reference', box: { xRatio: 0, yRatio: 0, widthRatio: 0.5, heightRatio: 0.2 } }],
    });
    expect(prompt).toContain('Treat each attached reference crop (Image 2 onward, per the manifest above) as a TEMPLATE to fill in, not inspiration for a new design');
    expect(prompt).toContain('The ONLY thing that should differ from the crop is the actual text content');
  });

  it('round 6 fix: states a real HARD BOUNDARY (marginXRatio + textColumnWidthRatio) keeping text off the photo subject, bookended in the closing rules', () => {
    // STYLE: marginXRatio 0.04 + textColumnWidthRatio 0.35 = 0.39 -> 39%, canvasW 1024 -> ~399px
    const prompt = buildFullContextEditPrompt(BASE_PARAMS);
    expect(prompt).toContain("HARD BOUNDARY: all text and design elements (headline, subtext, CTA, trust list) must stay entirely within the left 39% of canvas width (~399px");
    expect(prompt).toContain('the photo\'s subject occupies the space to the right of this boundary and must never be touched, crowded, or covered.');
    // Bookended - the same number appears again in the closing "Do NOT" list.
    expect(prompt).toContain('Do NOT let any text or design element extend past the left 39% of canvas width (~399px)');
  });

  it('real bug found live: a CENTERED element is anchored on style.centerXRatio directly, NOT derived from marginXRatio + textColumnWidthRatio/2 - a real reference (subject below the text, not beside it) measured its true center at ~50% of canvas width while that column formula computed ~35%, and the edit model followed the wrong number faithfully', () => {
    const centeredStyle: PosterStyleSpec = {
      ...STYLE,
      headline: { ...STYLE.headline, align: 'center' },
      // Deliberately far from marginXRatio(0.04) + textColumnWidthRatio(0.35)/2 = 0.215,
      // so a passing test can only mean centerXRatio was actually read directly.
      centerXRatio: 0.5,
    };
    const prompt = buildFullContextEditPrompt({ ...BASE_PARAMS, style: centeredStyle, canvasW: 1000 });
    expect(prompt).toContain('land close to 50% of canvas width (~500px from the left edge)');
    expect(prompt).not.toContain('22%'); // the old column-derived answer (0.215 -> ~22%), must not leak through
  });
});

describe('selectElementsToCrop', () => {
  const box = { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.1 };
  const recommended: VisualReferenceHint = { recommended: true, box };

  it('returns nothing when no element is recommended', () => {
    expect(selectElementsToCrop(STYLE)).toEqual([]);
  });

  it('includes a recommended headline/subtext/cta/trustList element, skips a non-present one even if flagged recommended', () => {
    const style: PosterStyleSpec = {
      ...STYLE,
      headline: { ...STYLE.headline, visualReference: recommended },
      cta: { ...STYLE.cta, present: false, visualReference: recommended }, // present:false must win over recommended:true
      trustList: { ...STYLE.trustList, visualReference: recommended },
    };
    const selected = selectElementsToCrop(style);
    const names = selected.map((c) => c.name);
    expect(names).toContain('headline');
    expect(names).toContain('trustList');
    expect(names).not.toContain('cta');
  });

  it('includes an otherElements entry by its own index-based name', () => {
    const el = {
      description: 'a badge', positionDescription: 'below the logo', align: 'left' as const, approxYRatio: 0.1, approxHeightRatio: 0.05, gapAboveRatio: 0.01,
      parts: [{ text: null, hasText: false, styleDescription: 'plain', color: { type: 'solid' as const, color: '#fff' } }],
      visualReference: recommended,
    };
    const style: PosterStyleSpec = { ...STYLE, otherElements: [el], elementOrder: [...STYLE.elementOrder, 'otherElements[0]'] };
    const selected = selectElementsToCrop(style);
    expect(selected.map((c) => c.name)).toEqual(['otherElements[0]']);
  });

  it('real bug guard: a recommended:true hint with a degenerate box (as clampStyle would produce) never reaches here', () => {
    // clampVisualReferenceHint forces recommended back to false when the
    // box can't back a real crop - this simulates that already-clamped
    // shape, confirming selectElementsToCrop trusts it at face value
    // rather than re-validating (that validation is clampStyle's job).
    const degenerate: VisualReferenceHint = { recommended: false, box: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } };
    const style: PosterStyleSpec = { ...STYLE, headline: { ...STYLE.headline, visualReference: degenerate } };
    expect(selectElementsToCrop(style)).toEqual([]);
  });

  it('orders selections to match elementOrder, not insertion order', () => {
    const style: PosterStyleSpec = {
      ...STYLE,
      headline: { ...STYLE.headline, visualReference: recommended },
      trustList: { ...STYLE.trustList, visualReference: recommended },
      elementOrder: ['headline', 'subtext', 'cta', 'trustList'], // trustList after headline
    };
    expect(selectElementsToCrop(style).map((c) => c.name)).toEqual(['headline', 'trustList']);

    const reordered: PosterStyleSpec = { ...style, elementOrder: ['trustList', 'headline', 'subtext', 'cta'] };
    expect(selectElementsToCrop(reordered).map((c) => c.name)).toEqual(['trustList', 'headline']);
  });

  it('round 6 fix: the mandatory tier (headline/subtext/cta) is NEVER trimmed by the cap, even when it sorts last in elementOrder and optional candidates would otherwise fill the whole budget', () => {
    const els = Array.from({ length: MAX_REFERENCE_CROPS }, (_, i) => ({
      description: `element ${i}`, positionDescription: 'somewhere', align: 'left' as const, approxYRatio: 0.1, approxHeightRatio: 0.05, gapAboveRatio: 0.01,
      parts: [{ text: null, hasText: false, styleDescription: 'plain', color: { type: 'solid' as const, color: '#fff' } }],
      visualReference: recommended,
    }));
    const style: PosterStyleSpec = {
      ...STYLE,
      cta: { ...STYLE.cta, visualReference: recommended }, // mandatory, but ranked LAST below
      otherElements: els,
      // A naive "sort by elementOrder then slice(0, cap)" would push cta
      // out entirely here, since it's ranked after every otherElements
      // entry - the mandatory tier must survive regardless of position.
      elementOrder: [...els.map((_, i) => `otherElements[${i}]`), 'headline', 'subtext', 'cta'],
    };
    const names = selectElementsToCrop(style).map((c) => c.name);
    expect(names).toContain('cta');
    expect(selectElementsToCrop(style).length).toBe(MAX_REFERENCE_CROPS);
  });

  it('round 6 fix: MAX_REFERENCE_CROPS is raised to 6 (3 mandatory + up to 3 structural)', () => {
    expect(MAX_REFERENCE_CROPS).toBe(6);
  });

  it('caps at MAX_REFERENCE_CROPS even when more elements are recommended', () => {
    const els = Array.from({ length: 6 }, (_, i) => ({
      description: `element ${i}`, positionDescription: 'somewhere', align: 'left' as const, approxYRatio: 0.1, approxHeightRatio: 0.05, gapAboveRatio: 0.01,
      parts: [{ text: null, hasText: false, styleDescription: 'plain', color: { type: 'solid' as const, color: '#fff' } }],
      visualReference: recommended,
    }));
    const style: PosterStyleSpec = {
      ...STYLE,
      headline: { ...STYLE.headline, visualReference: recommended },
      subtext: { ...STYLE.subtext, visualReference: recommended },
      cta: { ...STYLE.cta, visualReference: recommended },
      trustList: { ...STYLE.trustList, visualReference: recommended },
      otherElements: els,
      elementOrder: [...STYLE.elementOrder, ...els.map((_, i) => `otherElements[${i}]`)],
    };
    expect(selectElementsToCrop(style).length).toBe(MAX_REFERENCE_CROPS);
  });
});

describe('buildVerificationRubric', () => {
  it('checks every copy field word-for-word, organized under 7 named fields', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('1. "headline"');
    expect(rubric).toContain('Feel Good All Day Every Single Time');
    expect(rubric).toContain('2. "subtext"');
    expect(rubric).toContain('A simple daily stretching routine');
    expect(rubric).toContain('3. "cta"');
    expect(rubric).toContain('JOIN TODAY');
    expect(rubric).toContain('From ₹299/month');
    expect(rubric).toContain('4. "otherElements"');
    expect(rubric).toContain('Flexible timing');
  });

  it('requires the photo and logo to look unaltered - the mask no longer guarantees this structurally', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('5. "photoAndLogo"');
    expect(rubric).toContain('the photo itself looks different from before this edit');
    expect(rubric).toContain('the brand logo is covered, moved, resized, recolored, or otherwise altered');
  });

  it('real bug found live: the "photo altered" hard-fail names a fabricated physical prop (e.g. a race bib) as an example, not just scene/lighting changes', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('including any new physical object, prop, or accessory appearing on or near the subject that was not part of the original photo');
    expect(rubric).toContain('e.g. a race bib, a new clothing item, jewelry, a sign');
  });

  it('does not treat trivial trailing punctuation as a word-for-word failure', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('It does NOT mean punctuation has to match exactly');
  });

  it('real bug found live: does not treat capitalization differences (e.g. ALL CAPS rendering) as a word-for-word failure', () => {
    // level-5 self-contradiction: the judge correctly waved through a
    // caps-only difference on one field but called the identical kind of
    // difference a hard fail on another - closing the same gap that
    // already exists for punctuation should make this consistent.
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('It also does NOT mean capitalization has to match exactly');
    expect(rubric).toContain('judge word identity by content, not by casing');
  });

  it("attaches the campaign's actual reference image as a style/fidelity anchor, not just the text checks", () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain("campaign's actual reference image is attached below");
  });

  it('real bug found live: hard-fails an added CTA when the style spec says none should exist', () => {
    const noCta: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, present: false } };
    const rubric = buildVerificationRubric(COPY, noCta);
    expect(rubric).toContain('3. "cta" - this design has no CTA button. Pass automatically UNLESS one incorrectly appears.');
  });

  it('does not include the "no CTA" wording when a CTA legitimately exists', () => {
    const rubric = buildVerificationRubric(COPY, STYLE); // STYLE.cta.present = true
    expect(rubric).not.toContain('this design has no CTA button');
  });

  it('hard-fails added checkmarks/bullets when the design uses plain text with no icon', () => {
    const bulletStyle: PosterStyleSpec = { ...STYLE, trustList: { ...STYLE.trustList, iconStyle: 'none' } };
    const rubric = buildVerificationRubric(COPY, bulletStyle);
    expect(rubric).toContain('checkmark icons or bullet dots appear before the info-block items');
  });

  it('hard-fails an added promo badge when none should exist', () => {
    const rubric = buildVerificationRubric(COPY, STYLE); // promoBadge.present = false
    expect(rubric).toContain('a separate promo/offer badge');
  });

  it('folds size/color closeness into the soft-scoring sentence rather than a new hard-fail bucket', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('how closely the rendered text sizing and coloring matches the specified targets');
  });

  it('round 4 fix: hard-fails a hallucinated CTA price band when the style spec says the CTA has none', () => {
    const noPriceBand: PosterStyleSpec = { ...STYLE, cta: { ...STYLE.cta, hasPriceBand: false } };
    const rubric = buildVerificationRubric(COPY, noPriceBand);
    expect(rubric).toContain("a second price/offer band appears inside or below the CTA button, even though this design's CTA has none");

    const withBand = buildVerificationRubric(COPY, STYLE); // STYLE.cta.hasPriceBand = true
    expect(withBand).not.toContain("this design's CTA has none");
  });

  it('round 8 fix: hard-fails a fabricated CTA price band when hasPriceBand is true but no genuine priceText was generated', () => {
    const noRealPrice: AdCopy = { ...COPY, priceText: undefined };
    const rubric = buildVerificationRubric(noRealPrice, STYLE); // STYLE.cta.hasPriceBand = true
    expect(rubric).toContain('a second price/offer band (with any price or offer text, real or invented) appears inside or below the CTA button, even though no genuine price was specified for this campaign');

    const withRealPrice = buildVerificationRubric(COPY, STYLE); // COPY.priceText is set
    expect(withRealPrice).not.toContain('even though no genuine price was specified');
  });

  it('round 4 fix: hard-fails a hallucinated highlighted price row in the info block when the style spec says none exists', () => {
    const rubric = buildVerificationRubric(COPY, STYLE); // STYLE.trustList.priceRow.present = false
    expect(rubric).toContain('a highlighted price/offer row appears inside the bottom info block, even though this design has none');

    const withRow: PosterStyleSpec = { ...STYLE, trustList: { ...STYLE.trustList, priceRow: { ...STYLE.trustList.priceRow, present: true } } };
    const prompt = buildVerificationRubric(COPY, withRow);
    expect(prompt).not.toContain('a highlighted price/offer row appears');
  });

  it('round 8 fix: hard-fails only SUBSTANTIAL overlap with the photo\'s own subject, explicitly allows a minor incidental graze', () => {
    const rubric = buildVerificationRubric(COPY, STYLE);
    expect(rubric).toContain('7. "legibility"');
    expect(rubric).toContain("any text/icon SUBSTANTIALLY overlaps or covers the photo's own subject (a face, hands, or a meaningful portion of the body");
    expect(rubric).toContain("a minor, incidental graze, e.g. a letter's edge lightly touching an arm or background element, is NOT a failure on its own");
  });

  it('round 7 fix: hard-fails otherElementTexts mismatches word-for-word - previously this field had no check at all', () => {
    const copyWithOther: AdCopy = { ...COPY, otherElementTexts: ['Presented By Insider Daily'] };
    const rubric = buildVerificationRubric(copyWithOther, STYLE);
    expect(rubric).toContain('the additional element labels do not match, word-for-word: "Presented By Insider Daily"');
  });

  it('omits the additional-element-labels hard-fail line when there are none', () => {
    const rubric = buildVerificationRubric(COPY, STYLE); // COPY.otherElementTexts = []
    expect(rubric).not.toContain('additional element labels');
  });

  it('real bug found live: does not name every otherElements sub-category in a fixed header regardless of what actually applies', () => {
    // Earlier draft always wrote "(trust points, additional element
    // labels, promo badge)" in the field-4 header, so "additional
    // element labels" showed up in the rubric even for a design with
    // zero otherElementTexts, just from the header text - defeating the
    // point of the "omits when there are none" test above for any job
    // that also has trust points or a promo badge.
    const onlyTrustItems: AdCopy = { ...COPY, otherElementTexts: [] };
    const rubric = buildVerificationRubric(onlyTrustItems, STYLE); // STYLE.trustList has no promoBadge either
    expect(rubric).toContain('4. "otherElements" - fails if the trust points do not match');
    expect(rubric).not.toContain('additional element labels');
  });

  it('real bug found live: checks alignment as its own field (8th) - previously nothing verified this at all, and a real job rendered with inconsistent, neither-left-nor-center positioning while scoring well', () => {
    const rubric = buildVerificationRubric(COPY, STYLE); // STYLE.headline.align = STYLE.subtext.align = 'left'
    expect(rubric).toContain('8. "alignment"');
    expect(rubric).toContain('the headline is not genuinely LEFT-aligned');
    expect(rubric).toContain('the subtext is not genuinely LEFT-aligned');
    // Teaches the judge the actual visual test, not just the word "left"/"center".
    expect(rubric).toContain('if every line starts at the exact same left x position regardless of how long each line is, that is LEFT alignment');
    expect(rubric).toContain("if each line's own horizontal midpoint lines up instead");
  });

  it('checks CENTER alignment instead when that is what the style spec calls for, per-element - never a fixed preference for either direction', () => {
    const centeredStyle: PosterStyleSpec = {
      ...STYLE,
      headline: { ...STYLE.headline, align: 'center' },
      subtext: { ...STYLE.subtext, align: 'left' }, // deliberately different from the headline - must be judged independently
    };
    const rubric = buildVerificationRubric(COPY, centeredStyle);
    expect(rubric).toContain('the headline is not genuinely CENTER-aligned');
    expect(rubric).toContain('the subtext is not genuinely LEFT-aligned');
  });

  it('checks each otherElements entry\'s own alignment independently', () => {
    const styleWithOther: PosterStyleSpec = {
      ...STYLE,
      otherElements: [
        { description: 'a badge', positionDescription: 'below the logo', align: 'center' as const, approxYRatio: 0.1, approxHeightRatio: 0.05, gapAboveRatio: 0.01, parts: [{ text: null, hasText: false, styleDescription: 'plain', color: { type: 'solid' as const, color: '#fff' } }], visualReference: NO_VISUAL_REF },
      ],
      elementOrder: [...STYLE.elementOrder, 'otherElements[0]'],
    };
    const rubric = buildVerificationRubric(COPY, styleWithOther);
    expect(rubric).toContain("additional element 1's content is not genuinely CENTER-aligned within the text column");
  });
});
