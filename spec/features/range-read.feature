@capability:range-read
Feature: Reading part of a file from the middle

  A video player that seeks asks for a byte range that starts in the middle of the file. The serve
  must answer with exactly those bytes, also when the range starts inside one 4 MiB block of the
  Drive and ends in a later one. Proton serves a file one 4 MiB block at a time, and each block
  takes a while to come, so the serve must fetch the blocks of a range at the same time, not one
  after the other.

  @id:a-range-from-the-middle-of-a-file-gives-exactly-those-bytes
  Scenario: A read of 12 MB from byte 5,000,000 of a 20 MiB file gives exactly those bytes, without waiting for its blocks one after the other
    Given the Drive's My files holds the 20 MiB file "Videos/trip.mkv"
    And the Drive takes 1 second to give each 4 MiB block a read of a file fetches
    When the user reads 12000000 bytes of "Videos/trip.mkv" from byte 5000000
    Then the serve answered the read as partial content, and the read gives the file's bytes from 5000000 to 16999999 within 2.5 seconds
