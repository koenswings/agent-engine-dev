/**
 * Sticker-name word lists (idea#184). REVIEW FILE: every word a Pi can be named with.
 *
 * Rules for these lists (keep them when editing):
 *  - lower-case letters a-z only, 3-8 letters, no digits;
 *  - common, short, easy to read, spell and pronounce for teachers in Africa
 *    and second-language readers (Latin script, no slang, no hard or
 *    variable spellings, no homophones or easily confused words);
 *  - neutral and friendly: no people, body, romance, religion or witchcraft,
 *    politics, currency, skin colour or race, insults, sexual slang, animals
 *    used as slurs (e.g. no ape/monkey/pig/donkey), animals that are bad omens
 *    in southern African folklore (e.g. owl), or conservation-sensitive goods
 *    (e.g. ivory);
 *  - no words that suggest numbering or rank (e.g. first, prime);
 *  - adjectives are positive or neutral; no word appears in both lists.
 *  Reviewed by Marco on PR #201 (2026-10-14).
 *
 * The generator (nameGenerator.ts) never pairs an adjective with the noun it
 * derives from (sandy-sand, starry-star, stony-stone, oaken-oak; detected by
 * suffix, see isDerivedPair) and skips the double-meaning pairs in
 * BLOCKED_PAIRS (e.g. silver-fox).
 *
 * 299 adjectives x 335 nouns = 100165 pairs; 100145 valid two-word names
 * after excluded pairs. Tests check the rules above and that the number of
 * valid names stays >= 100,000.
 */
export const ADJECTIVES = [
    'able', 'active', 'agile', 'airy', 'alert', 'alive', 'amber', 'ample',
    'artful', 'artistic', 'aware', 'azure', 'balanced', 'balmy', 'beige', 'best',
    'big', 'bold', 'bouncy', 'brave', 'breezy', 'brief', 'bright', 'brisk',
    'broad', 'bubbly', 'busy', 'calm', 'candid', 'capable', 'careful', 'caring',
    'casual', 'chatty', 'cheerful', 'chilly', 'chirpy', 'classic', 'clean', 'clear',
    'clever', 'cloudy', 'coastal', 'comfy', 'cool', 'copper', 'cosmic', 'creative',
    'crisp', 'curious', 'daily', 'daring', 'dashing', 'dazzling', 'decent', 'deep',
    'dewy', 'direct', 'dreamy', 'dry', 'dusty', 'dutiful', 'dynamic', 'eager',
    'early', 'earnest', 'easy', 'elegant', 'even', 'exact', 'expert', 'fabled',
    'famous', 'fancy', 'fast', 'fearless', 'festive', 'fine', 'fizzy', 'fleet',
    'floral', 'fluent', 'fluffy', 'flying', 'focused', 'fond', 'frank', 'free',
    'fresh', 'friendly', 'frosty', 'fruity', 'full', 'funny', 'gallant', 'generous',
    'gentle', 'genuine', 'gifted', 'glad', 'gleaming', 'gleeful', 'global', 'glossy',
    'glowing', 'golden', 'good', 'graceful', 'gracious', 'grand', 'grassy', 'grateful',
    'great', 'green', 'handy', 'happy', 'hardy', 'hazy', 'hearty', 'helpful',
    'heroic', 'hilly', 'honest', 'hopeful', 'humble', 'hushed', 'ideal', 'immense',
    'indigo', 'inspired', 'jade', 'jolly', 'jovial', 'joyful', 'joyous', 'keen',
    'kind', 'lasting', 'leafy', 'level', 'light', 'lilac', 'lively', 'local',
    'lofty', 'logical', 'lovely', 'loyal', 'lucky', 'lunar', 'lush', 'majestic',
    'marine', 'mellow', 'merry', 'mighty', 'mild', 'mindful', 'misty', 'modern',
    'modest', 'mossy', 'musical', 'mutual', 'natural', 'neat', 'nimble', 'noble',
    'novel', 'oaken', 'open', 'orderly', 'organic', 'pastel', 'patient', 'peaceful',
    'peachy', 'perfect', 'pink', 'plain', 'playful', 'pleasant', 'plucky', 'plush',
    'polar', 'polite', 'popular', 'precise', 'prompt', 'proper', 'proud', 'punctual',
    'purple', 'quick', 'radiant', 'rainy', 'rapid', 'rare', 'ready', 'real',
    'regal', 'relaxed', 'reliable', 'restful', 'rich', 'robust', 'rocky', 'rosy',
    'round', 'royal', 'rugged', 'rural', 'rustic', 'safe', 'sandy', 'satin',
    'scenic', 'secure', 'sensible', 'serene', 'sharp', 'shining', 'shiny', 'silent',
    'silky', 'silver', 'simple', 'sincere', 'skilled', 'sleek', 'smart', 'smiling',
    'smooth', 'snowy', 'snug', 'social', 'soft', 'solar', 'solid', 'sound',
    'sparkly', 'speedy', 'spirited', 'sporty', 'spotless', 'stable', 'starry', 'steady',
    'steep', 'stellar', 'stony', 'strong', 'sturdy', 'sunny', 'sunset', 'super',
    'sweet', 'swift', 'tactful', 'tall', 'tasty', 'terrific', 'thankful', 'thrifty',
    'tidal', 'tidy', 'timely', 'tiny', 'tireless', 'tranquil', 'trim', 'tropical',
    'true', 'trusty', 'tuneful', 'unique', 'upbeat', 'upright', 'useful', 'valiant',
    'vast', 'velvet', 'vibrant', 'vital', 'vivid', 'warm', 'watchful', 'wavy',
    'welcome', 'wide', 'willing', 'windy', 'winged', 'wise', 'witty', 'wooden',
    'worthy', 'zesty', 'zippy',
] as const

export const NOUNS = [
    'acacia', 'acorn', 'almond', 'aloe', 'alpaca', 'anchor', 'antelope', 'apple',
    'apricot', 'arch', 'arrow', 'aster', 'atlas', 'avocado', 'badger', 'bakery',
    'bamboo', 'banjo', 'baobab', 'barley', 'basil', 'basket', 'bay', 'beacon',
    'bean', 'bee', 'beetle', 'bicycle', 'bird', 'bison', 'blossom', 'boat',
    'bobcat', 'boulder', 'branch', 'bread', 'breeze', 'brick', 'bridge', 'brook',
    'bubble', 'bucket', 'buffalo', 'bugle', 'butter', 'button', 'cabin', 'cactus',
    'calabash', 'camel', 'candle', 'canoe', 'canyon', 'cape', 'carrot', 'cashew',
    'cassava', 'castle', 'cedar', 'chalk', 'cheetah', 'chess', 'cider', 'citrus',
    'clay', 'cliff', 'clock', 'cloud', 'clover', 'coast', 'cobalt', 'cocoa',
    'comet', 'compass', 'condor', 'cookie', 'coral', 'cotton', 'crane', 'crayon',
    'creek', 'cricket', 'crystal', 'cup', 'daisy', 'delta', 'desert', 'dew',
    'dolphin', 'dove', 'drum', 'dune', 'eagle', 'earth', 'echo', 'eland',
    'elm', 'ember', 'emerald', 'eraser', 'falcon', 'feather', 'fern', 'ferry',
    'field', 'fig', 'finch', 'flame', 'flamingo', 'flute', 'forest', 'fossil',
    'fountain', 'fox', 'garden', 'garnet', 'gazelle', 'gecko', 'ginger', 'giraffe',
    'glacier', 'globe', 'gorge', 'granite', 'grape', 'grove', 'guava', 'guitar',
    'harp', 'hawk', 'hazel', 'hedgehog', 'heron', 'hibiscus', 'hill', 'hilltop',
    'hippo', 'honey', 'horizon', 'ibis', 'impala', 'island', 'jasmine', 'jay',
    'jewel', 'journey', 'kalimba', 'kayak', 'kestrel', 'kettle', 'kite', 'kiwi',
    'koala', 'kudu', 'ladder', 'lagoon', 'lake', 'lantern', 'lark', 'lava',
    'leaf', 'lemon', 'lens', 'lily', 'lime', 'lion', 'lizard', 'llama',
    'lobster', 'lotus', 'lute', 'magnet', 'maize', 'mango', 'maple', 'marble',
    'marigold', 'marimba', 'marsh', 'marula', 'mbira', 'meadow', 'meerkat', 'melon',
    'meteor', 'millet', 'mint', 'mirror', 'mongoose', 'moon', 'moose', 'mopane',
    'moss', 'mountain', 'nectar', 'needle', 'nest', 'notebook', 'nova', 'nutmeg',
    'oak', 'oasis', 'ocean', 'okapi', 'olive', 'onyx', 'opal', 'orange',
    'orbit', 'orchid', 'oriole', 'osprey', 'ostrich', 'otter', 'oyster', 'paddle',
    'palm', 'panda', 'parrot', 'pawpaw', 'peanut', 'pearl', 'pebble', 'pelican',
    'pencil', 'pepper', 'petal', 'piano', 'pillar', 'pine', 'planet', 'plum',
    'pond', 'poplar', 'pottery', 'prairie', 'protea', 'puffin', 'pumpkin', 'quail',
    'quartz', 'quill', 'rabbit', 'radish', 'rain', 'rainbow', 'reef', 'rhino',
    'ribbon', 'ridge', 'river', 'robin', 'rocket', 'rose', 'ruby', 'saddle',
    'saffron', 'sage', 'salmon', 'sand', 'sapphire', 'satchel', 'scarf', 'seal',
    'seashell', 'seed', 'sesame', 'shell', 'shore', 'sky', 'slate', 'sorghum',
    'sparrow', 'spice', 'spoon', 'spring', 'spruce', 'squash', 'star', 'starfish',
    'starling', 'stone', 'stork', 'stream', 'summit', 'sun', 'sunbeam', 'sunbird',
    'sunrise', 'swan', 'tamarind', 'tango', 'tea', 'teacup', 'teapot', 'thunder',
    'tiger', 'tilapia', 'timber', 'tomato', 'topaz', 'torch', 'tortoise', 'toucan',
    'tower', 'trail', 'trumpet', 'tulip', 'tundra', 'turtle', 'ukulele', 'umbrella',
    'valley', 'vanilla', 'violet', 'violin', 'volcano', 'wagon', 'walnut', 'walrus',
    'warbler', 'water', 'wave', 'weaver', 'wheat', 'wheel', 'willow', 'wind',
    'windmill', 'window', 'wolf', 'wren', 'yak', 'yam', 'zebra',
] as const

/** Pairs with a double meaning that the generator never produces. */
export const BLOCKED_PAIRS: readonly string[] = [
    'silver-fox',
    'sweet-honey',
]
