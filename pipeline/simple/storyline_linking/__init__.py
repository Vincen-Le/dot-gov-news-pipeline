"""Judge-gated assignment of entries to episodes and storylines.

The package owns top-N candidate retrieval and all three assignment outcomes:
join the active episode, create an episode under a matched storyline, or
create a unique storyline.
"""

from pipeline.simple.storyline_linking.index import LiveStoryline, StorylineIndex
from pipeline.simple.storyline_linking.linker import Linker

__all__ = ["Linker", "LiveStoryline", "StorylineIndex"]
