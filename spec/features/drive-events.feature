@capability:drive-events
Feature: Changes made elsewhere reach the serve through Drive events

  @id:a-file-added-elsewhere-shows-after-the-next-events
  Scenario: A file another client adds shows after the serve reads the Drive's events
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    When the user lists "Photos"
    And another client adds the file "Photos/hill.jpg" containing "green hill"
    And the serve reads the Drive's events
    And the user lists "Photos" again
    Then the listing shows exactly:
      | name      | kind | size |
      | beach.jpg | file | 12   |
      | hill.jpg  | file | 10   |

  @id:a-file-trashed-elsewhere-goes-after-the-next-events
  Scenario: A file another client trashes goes after the serve reads the Drive's events
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the Drive's My files holds the file "Photos/hill.jpg" containing "green hill"
    When the user lists "Photos"
    And another client trashes "Photos/hill.jpg"
    And the serve reads the Drive's events
    And the user lists "Photos" again
    Then the listing shows exactly:
      | name      | kind | size |
      | beach.jpg | file | 12   |

  @id:the-serve-never-walks-the-folder-tree
  Scenario: The serve never walks the folder tree
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the Drive's My files holds the file "Videos/clip.mp4" containing "waves"
    And the Drive's My files holds the file "Documents/cv.pdf" containing "resume"
    When the serve starts and reads the Drive's events 20 times
    Then the serve read the Drive's events 20 times, and the Drive listed no folder

  @id:the-serve-reads-no-events-during-a-rate-limit-pause
  Scenario: The serve reads no events during a rate-limit pause
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the Drive rate-limits the next listing of "Photos"
    When the user lists "Photos"
    And the Drive's event scheduler calls the serve
    Then the listing was refused as rate-limited, and the serve read no events when the scheduler called it
