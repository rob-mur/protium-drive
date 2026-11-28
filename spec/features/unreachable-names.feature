@capability:unreachable-names
Feature: Names no path can hold

  A Drive can hold a name that no path can: ".", "..", a name with a slash or a NUL, or one over
  the 255 bytes a Linux name can hold. The serve does not list such a file, and warns of it once.

  @id:a-name-no-path-can-hold-is-not-listed-and-its-skip-is-logged-once
  Scenario: A file named ".", "..", with a slash, with a NUL or of 300 bytes is not listed, and the serve warns once of each
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand"
    And the Drive's "Photos" also holds a file named each of ".", "..", one with a slash, one with a NUL, and one of 300 bytes
    When the user lists "Photos"
    And the user lists "Photos" again
    Then the listing of "Photos" shows only "beach.jpg", and the serve warned once of each of those files that it skipped it
