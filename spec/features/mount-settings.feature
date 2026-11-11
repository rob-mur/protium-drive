@capability:mount-settings
Feature: The mount's cache settings

  @id:a-file-added-elsewhere-shows-in-the-mount-after-the-dir-cache-time
  Scenario: A file another client adds shows in the mounted folder once the dir cache time passes
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder with a dir cache time of "5s"
    When the user lists the mounted folder "Photos"
    And another client adds the file "Photos/hill.jpg" containing "green hill"
    And the serve reads the Drive's events
    Then within 15 seconds the mounted folder "Photos" holds exactly "beach.jpg, hill.jpg"

  @id:a-same-size-edit-elsewhere-shows-in-the-mount-after-the-dir-cache-time
  Scenario: A file another client replaces with content of the same size shows its new content once the dir cache time passes
    Given a Drive whose My files holds the file "a.txt" containing "aaaa"
    And the user mounts the Drive at a folder with a dir cache time of "5s"
    When the user reads the mounted file "a.txt"
    And another client replaces the file "a.txt" with "bbbb"
    And the serve reads the Drive's events
    Then the mounted file "a.txt" held "aaaa" at first, and within 20 seconds it holds "bbbb" on two reads in a row

  @id:a-dir-cache-time-that-is-not-a-duration-stops-the-mount-before-the-serve
  Scenario: A dir cache time that is not a duration stops the mount before the serve starts
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder with a dir cache time of "banana"
    When the user starts the mount
    Then the mount exited with status 2, naming the dir cache time, and served nothing
