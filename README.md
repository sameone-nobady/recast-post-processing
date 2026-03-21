# Recast | Prose Post-Processing

Large language models get better every day, but their performance in multi-tasking and chatting degrades, keeping track of complex worlds, multiple characters, trackers, repetition...It gets messed up fast. Recast Post-processing solves that by allowing certain prompts and corrections to be applied after the original response was made, without touching the original prompt, therefore not poisoning it.
The idea is simple, allowing smaller models to take on smaller, specific tasks such as changing prose quality, validating character behavior or anything else you may want to add at the cost of extra requests.

## Features

- Make sure every response is creative, complex, detailed and coherent by making multiple requests that asses and rewrite the response without using your original prompt.
- Can be used to also add trackers, extra information or to flavor up the text.
- Supports Connection Profiles, essentially every model that can connect to SillyTavern.

## Installation and Usage

### Installation

Just copy this link and install it in your SillyTavern.

### Usage

Simply install it and setup different connections with smaller models. I recommend using emotionally aware models for Character Validation (without reasoning) and a reasoning model for Prose Refinement.
Its probably not compatible with Text Completion.

## Prerequisites

Tested and build on Latest Staging build.

## Support and Contributions

Contact me through both the Discord extension post or Reddit comments on the original post regarding this extension.

You can help with commits and submitting bug-reports!

## License

AGPL-3.0 LICENSE